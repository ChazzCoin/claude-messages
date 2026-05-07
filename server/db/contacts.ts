import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database from 'better-sqlite3';

/**
 * Read macOS Contacts (AddressBook) SQLite databases to map iMessage
 * handles (phone numbers, emails) to real contact names. Read-only,
 * defensive: schema differences across macOS versions and missing
 * databases degrade gracefully to "no name found."
 *
 * Same Full Disk Access gate as chat.db. If the user has FDA for the
 * runner, both work; otherwise lookups silently return null.
 */

export interface ContactInfo {
  full_name: string;
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  job_title: string | null;
  department: string | null;
  /** Free-form notes the user has typed into Contacts.app. Long-form. */
  notes: string | null;
  /** Human-readable birthday like "March 12" (year unknown) or "March 12, 1985". */
  birthday: string | null;
}

export interface ContactWithHandles extends ContactInfo {
  handles: string[];
}

let _byHandle: Map<string, ContactInfo> | null = null;
let _allContacts: ContactInfo[] | null = null;

function findAddressBookDbs(): string[] {
  const root = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook');
  const candidates: string[] = [];

  if (!fs.existsSync(root)) {
    console.warn(`[contacts] AddressBook root missing: ${root}`);
    return [];
  }

  // Walk the entire AddressBook tree, looking for any .abcddb file. macOS
  // splits sources (iCloud, Local, Exchange, CardDAV) into Sources/<UUID>/
  // subdirs, and the exact layout has shifted over macOS versions — recursive
  // scan beats hardcoded paths.
  const walk = (dir: string, depth: number): void => {
    if (depth > 5) return; // cap recursion just in case
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith('.abcddb')) {
        candidates.push(full);
      }
    }
  };
  walk(root, 0);
  return candidates;
}

/**
 * Normalize a phone number to chat.db's stored form (E.164 with +).
 * AddressBook stores phones in many formats; chat.db's `handle.id`
 * for phones is consistently like "+15551234567". We coerce to that.
 */
function normalizePhone(raw: string): string {
  if (!raw) return '';
  const digits = raw.replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  // Treat anything else as already-international; preserve digits.
  return `+${digits}`;
}

/**
 * Normalize ANY handle (phone or email) to the canonical form chat.db uses.
 * Used everywhere the user types a handle into a form so we can match against
 * what the watcher emits. Idempotent — feeding canonical input through it
 * returns the same canonical output.
 */
export function normalizeHandle(raw: string | null | undefined): string {
  if (raw == null) return '';
  const trimmed = String(raw).trim();
  if (!trimmed) return '';
  if (trimmed.includes('@')) return trimmed.toLowerCase();
  // Empty after stripping non-digits → unparseable; pass through unchanged so
  // the user can see what they typed.
  const digits = trimmed.replace(/\D/g, '');
  if (!digits) return trimmed;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return `+${digits}`;
}

function makeFullName(c: {
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  nickname?: string | null;
}): string {
  const parts: string[] = [];
  if (c.first_name) parts.push(c.first_name);
  if (c.last_name) parts.push(c.last_name);
  if (parts.length > 0) return parts.join(' ');
  if (c.nickname) return c.nickname;
  return c.organization || '';
}

interface RawRecord {
  id: number;
  first_name: string | null;
  last_name: string | null;
  organization: string | null;
  nickname: string | null;
  job_title: string | null;
  department: string | null;
  /** ZBIRTHDAY: Apple-epoch seconds (negative for pre-2001 dates). */
  birthday_apple: number | null;
  /** ZBIRTHDAYYEAR: explicit year override; null/1604 = "year unknown". */
  birthday_year: number | null;
  /** ZNOTE: foreign key into ZABCDNOTE.Z_PK. */
  note_id: number | null;
}

/** Apple uses 1604 as a placeholder year when the user only entered month/day. */
const BIRTHDAY_YEAR_UNKNOWN = 1604;
const APPLE_EPOCH_OFFSET_S = 978307200;
const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function formatBirthday(appleSeconds: number | null, explicitYear: number | null): string | null {
  if (appleSeconds === null || !Number.isFinite(appleSeconds)) return null;
  const ms = (appleSeconds + APPLE_EPOCH_OFFSET_S) * 1000;
  const d = new Date(ms);
  if (isNaN(d.getTime())) return null;
  const month = MONTH_NAMES[d.getUTCMonth()];
  const day = d.getUTCDate();
  const yearFromTimestamp = d.getUTCFullYear();
  // Prefer explicit ZBIRTHDAYYEAR when set & not the placeholder; else use the
  // year from ZBIRTHDAY unless that's also the placeholder (no year known).
  const yearKnown =
    (explicitYear !== null && explicitYear !== BIRTHDAY_YEAR_UNKNOWN) ||
    (explicitYear === null && yearFromTimestamp !== BIRTHDAY_YEAR_UNKNOWN);
  const displayYear = explicitYear && explicitYear !== BIRTHDAY_YEAR_UNKNOWN
    ? explicitYear
    : yearFromTimestamp;
  return yearKnown ? `${month} ${day}, ${displayYear}` : `${month} ${day}`;
}

function readContactsFrom(dbPath: string): {
  handles: Array<{ handle: string; info: ContactInfo }>;
  all: ContactInfo[];
} {
  const out = {
    handles: [] as Array<{ handle: string; info: ContactInfo }>,
    all: [] as ContactInfo[],
  };
  let db: Database.Database | null = null;
  try {
    db = new Database(dbPath, { readonly: true, fileMustExist: true });

    const records = db
      .prepare(
        `
        SELECT Z_PK           AS id,
               ZFIRSTNAME     AS first_name,
               ZLASTNAME      AS last_name,
               ZORGANIZATION  AS organization,
               ZNICKNAME      AS nickname,
               ZJOBTITLE      AS job_title,
               ZDEPARTMENT    AS department,
               ZBIRTHDAY      AS birthday_apple,
               ZBIRTHDAYYEAR  AS birthday_year,
               ZNOTE          AS note_id
        FROM ZABCDRECORD
        `,
      )
      .all() as RawRecord[];

    // Pull all note bodies in one shot, keyed by note PK so we can attach
    // them to records by ZNOTE FK without N+1 queries.
    const notesByPk = new Map<number, string>();
    try {
      const noteRows = db
        .prepare('SELECT Z_PK AS pk, ZTEXT AS text FROM ZABCDNOTE WHERE ZTEXT IS NOT NULL')
        .all() as Array<{ pk: number; text: string | null }>;
      for (const n of noteRows) {
        if (n.text && n.text.trim()) notesByPk.set(n.pk, n.text.trim());
      }
    } catch (err) {
      console.warn(`[contacts] note read failed for ${dbPath}: ${(err as Error).message}`);
    }

    const recordById = new Map<number, ContactInfo>();
    for (const r of records) {
      const info: ContactInfo = {
        first_name: r.first_name,
        last_name: r.last_name,
        organization: r.organization,
        job_title: r.job_title,
        department: r.department,
        notes: r.note_id !== null ? notesByPk.get(r.note_id) ?? null : null,
        birthday: formatBirthday(r.birthday_apple, r.birthday_year),
        full_name: makeFullName({
          first_name: r.first_name,
          last_name: r.last_name,
          organization: r.organization,
          nickname: r.nickname,
        }),
      };
      // Don't drop phone-only contacts — keep with a placeholder name.
      // The autocomplete UI can still match by handle, and the Inbox can
      // resolve "+15551234567 → +15551234567 (no name)" gracefully.
      if (!info.full_name) info.full_name = '(unnamed contact)';
      recordById.set(r.id, info);
      out.all.push(info);
    }

    try {
      const phones = db
        .prepare(
          `
          SELECT ZOWNER      AS owner,
                 ZFULLNUMBER AS full_number
          FROM ZABCDPHONENUMBER
          WHERE ZFULLNUMBER IS NOT NULL
          `,
        )
        .all() as Array<{ owner: number; full_number: string }>;
      for (const p of phones) {
        const info = recordById.get(p.owner);
        if (!info) continue;
        const normalized = normalizePhone(p.full_number);
        if (normalized) out.handles.push({ handle: normalized, info });
      }
    } catch (err) {
      console.warn(`[contacts] phone read failed for ${dbPath}: ${(err as Error).message}`);
    }

    try {
      const emails = db
        .prepare(
          `
          SELECT ZOWNER  AS owner,
                 ZADDRESS AS address
          FROM ZABCDEMAILADDRESS
          WHERE ZADDRESS IS NOT NULL
          `,
        )
        .all() as Array<{ owner: number; address: string }>;
      for (const e of emails) {
        const info = recordById.get(e.owner);
        if (!info) continue;
        const handle = e.address.toLowerCase().trim();
        if (handle) out.handles.push({ handle, info });
      }
    } catch (err) {
      console.warn(`[contacts] email read failed for ${dbPath}: ${(err as Error).message}`);
    }
  } catch (err) {
    console.warn(`[contacts] failed to open ${dbPath}: ${(err as Error).message}`);
  } finally {
    db?.close();
  }
  return out;
}

function buildIndex(): { byHandle: Map<string, ContactInfo>; all: ContactInfo[] } {
  const byHandle = new Map<string, ContactInfo>();
  const all: ContactInfo[] = [];
  const dbs = findAddressBookDbs();
  console.log(`[contacts] discovered ${dbs.length} AddressBook .abcddb file(s)`);
  for (const dbPath of dbs) {
    const result = readContactsFrom(dbPath);
    const before = byHandle.size;
    for (const c of result.all) all.push(c);
    for (const { handle, info } of result.handles) {
      if (!byHandle.has(handle)) byHandle.set(handle, info);
    }
    const newBindings = byHandle.size - before;
    console.log(
      `[contacts]   ${dbPath}: ${result.all.length} contacts, +${newBindings} new handle bindings`,
    );
  }
  return { byHandle, all };
}

function ensureLoaded() {
  if (_byHandle === null) {
    const { byHandle, all } = buildIndex();
    _byHandle = byHandle;
    _allContacts = all;
    console.log(
      `[contacts] indexed ${all.length} contacts, ${byHandle.size} handle bindings (phones+emails)`,
    );
  }
}

export function preloadContacts(): void {
  ensureLoaded();
}

export function getContactByHandle(handle: string | null | undefined): ContactInfo | null {
  ensureLoaded();
  if (!handle) return null;
  const key = handle.includes('@') ? handle.toLowerCase().trim() : handle.trim();
  return _byHandle!.get(key) ?? null;
}

export function getContactNameForHandle(handle: string | null | undefined): string | null {
  return getContactByHandle(handle)?.full_name ?? null;
}

export function listAllContacts(): ContactInfo[] {
  ensureLoaded();
  return _allContacts!.slice();
}

/**
 * Same as listAllContacts but each row includes the handles (phones/emails)
 * that resolve to that contact. Used by the autocomplete in the UI so users
 * can type a name and have the handle filled in automatically.
 */
export function listContactsWithHandles(): ContactWithHandles[] {
  ensureLoaded();
  // Invert the handle map by ContactInfo identity (each contact is a single object).
  const byContact = new Map<ContactInfo, string[]>();
  for (const [handle, info] of _byHandle!) {
    const list = byContact.get(info);
    if (list) list.push(handle);
    else byContact.set(info, [handle]);
  }
  const out: ContactWithHandles[] = [];
  for (const info of _allContacts!) {
    const handles = byContact.get(info);
    if (!handles || handles.length === 0) continue;
    out.push({ ...info, handles });
  }
  return out;
}

export function reloadContacts(): { count: number; handle_bindings: number } {
  _byHandle = null;
  _allContacts = null;
  ensureLoaded();
  return { count: _allContacts!.length, handle_bindings: _byHandle!.size };
}

/**
 * Format a contact's AddressBook record as a multi-line block suitable for
 * injection into an AI draft prompt. Returns empty string when no field is
 * worth surfacing — caller can null-check and skip the section.
 *
 * Intentionally compact: the model already has the contact's name from the
 * thread attribution. This block adds the *latent* context — what the user
 * has stored about this person but hasn't said in the thread itself.
 */
export function formatContactContext(info: ContactInfo | null): string {
  if (!info) return '';
  const lines: string[] = [];
  const role: string[] = [];
  if (info.job_title) role.push(info.job_title);
  if (info.department) role.push(info.department);
  if (info.organization) role.push(`at ${info.organization}`);
  if (role.length) lines.push(`Role: ${role.join(' ')}`);
  if (info.birthday) lines.push(`Birthday: ${info.birthday}`);
  if (info.notes) lines.push(`User's notes:\n${info.notes}`);
  return lines.join('\n');
}
