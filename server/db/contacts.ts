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
}

export interface ContactWithHandles extends ContactInfo {
  handles: string[];
}

let _byHandle: Map<string, ContactInfo> | null = null;
let _allContacts: ContactInfo[] | null = null;

function findAddressBookDbs(): string[] {
  const root = path.join(os.homedir(), 'Library', 'Application Support', 'AddressBook');
  const candidates: string[] = [];

  const topPath = path.join(root, 'AddressBook-v22.abcddb');
  if (fs.existsSync(topPath)) candidates.push(topPath);

  const sourcesDir = path.join(root, 'Sources');
  if (fs.existsSync(sourcesDir)) {
    for (const d of fs.readdirSync(sourcesDir)) {
      const p = path.join(sourcesDir, d, 'AddressBook-v22.abcddb');
      if (fs.existsSync(p)) candidates.push(p);
    }
  }
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

function makeFullName(c: Omit<ContactInfo, 'full_name'> & { nickname?: string | null }): string {
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
               ZNICKNAME      AS nickname
        FROM ZABCDRECORD
        `,
      )
      .all() as RawRecord[];

    const recordById = new Map<number, ContactInfo>();
    for (const r of records) {
      const info: ContactInfo = {
        first_name: r.first_name,
        last_name: r.last_name,
        organization: r.organization,
        full_name: makeFullName({
          first_name: r.first_name,
          last_name: r.last_name,
          organization: r.organization,
          nickname: r.nickname,
        }),
      };
      if (!info.full_name) continue;
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
  for (const dbPath of dbs) {
    const result = readContactsFrom(dbPath);
    for (const c of result.all) all.push(c);
    for (const { handle, info } of result.handles) {
      if (!byHandle.has(handle)) byHandle.set(handle, info);
    }
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
