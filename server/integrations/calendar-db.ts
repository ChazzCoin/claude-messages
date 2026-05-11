// Calendar reader — direct sqlite, no AppleEvents.
//
// macOS 14+ silently stalls AppleEvent-based Calendar enumeration
// from a LaunchAgent context, even with TCC grants in place. To
// keep `list_calendar_events` working from the service, we read
// Calendar.app's local cache db directly:
//
//   ~/Library/Group Containers/group.com.apple.calendar/Calendar.sqlitedb
//
// This file is the consolidated cache Calendar.app maintains for
// every account (iCloud, Google CalDAV, local, etc.). Read-only;
// same Full Disk Access grant that chat.db uses covers it.
//
// Known limitations:
//   - Recurring events: we only return rows materialized in the
//     CalendarItem table. macOS keeps an OccurrenceCache for cached
//     recurrence instances but it's only populated for a sliding
//     window and is often stale. Future improvement: expand RRULE
//     ourselves for the requested window. For now, recurring events
//     may be missing — a documented gap.
//   - Tasks/Reminders: filtered out (entity_type != 1).

import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import Database, { type Database as DB } from 'better-sqlite3';

const CALENDAR_DB_PATH = path.join(
  os.homedir(),
  'Library',
  'Group Containers',
  'group.com.apple.calendar',
  'Calendar.sqlitedb',
);

let _db: DB | null = null;

function getDb(): DB {
  if (_db) return _db;
  if (!fs.existsSync(CALENDAR_DB_PATH)) {
    throw new Error(`Calendar.sqlitedb not found at ${CALENDAR_DB_PATH}`);
  }
  _db = new Database(CALENDAR_DB_PATH, { readonly: true, fileMustExist: true });
  return _db;
}

export function closeCalendarDb(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
    _db = null;
  }
}

/** Apple stores dates as REAL seconds since 2001-01-01 UTC. */
function appleSecondsToUnixMs(raw: number | null): number | null {
  if (raw == null) return null;
  return Math.round((raw + 978307200) * 1000);
}

function unixMsToAppleSeconds(unixMs: number): number {
  return unixMs / 1000 - 978307200;
}

export interface DbCalendarEvent {
  uid: string;
  title: string;
  start_iso: string;
  end_iso: string;
  location: string | null;
  notes: string | null;
  calendar: string;
  all_day: boolean;
}

export interface ListEventsOptions {
  hoursBack?: number;
  hoursAhead?: number;
  /** Defaults to 200. Capped at 1000. */
  limit?: number;
}

/** Returns events whose start_date falls within the window. Hidden,
 *  phantom-master, and reminder rows are filtered out. */
export function listEventsInWindow(opts: ListEventsOptions = {}): DbCalendarEvent[] {
  const hoursBack  = Math.max(0, Math.min(720,  opts.hoursBack  ?? 0));
  const hoursAhead = Math.max(0, Math.min(8760, opts.hoursAhead ?? 168));
  const limit      = Math.max(1, Math.min(1000, opts.limit ?? 200));

  const now = Date.now();
  const startUnixMs = now - hoursBack  * 3_600_000;
  const endUnixMs   = now + hoursAhead * 3_600_000;
  const startApple = unixMsToAppleSeconds(startUnixMs);
  const endApple   = unixMsToAppleSeconds(endUnixMs);

  const db = getDb();
  const rows = db.prepare(`
    SELECT
      ci.UUID                   AS uid,
      ci.summary                AS title,
      ci.start_date             AS start_apple,
      ci.end_date               AS end_apple,
      ci.description            AS notes,
      ci.all_day                AS all_day,
      c.title                   AS calendar
    FROM CalendarItem ci
    LEFT JOIN Calendar c ON c.ROWID = ci.calendar_id
    WHERE ci.hidden = 0
      AND ci.entity_type != 1
      AND (ci.phantom_master IS NULL OR ci.phantom_master = 0)
      AND ci.start_date IS NOT NULL
      AND ci.start_date >= ?
      AND ci.start_date <  ?
    ORDER BY ci.start_date ASC
    LIMIT ?
  `).all(startApple, endApple, limit) as Array<{
    uid: string | null;
    title: string | null;
    start_apple: number | null;
    end_apple: number | null;
    notes: string | null;
    all_day: number | null;
    calendar: string | null;
  }>;

  // Dedup by (start, title) — the cache db often has the same event
  // duplicated across stores when iCloud and a CalDAV account both
  // sync the same calendar (especially Holidays in United States).
  const seen = new Set<string>();
  const out: DbCalendarEvent[] = [];
  for (const r of rows) {
    if (!r.title) continue;
    const startMs = appleSecondsToUnixMs(r.start_apple);
    const endMs   = appleSecondsToUnixMs(r.end_apple);
    if (startMs == null || endMs == null) continue;
    const key = `${startMs}::${r.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      uid: r.uid || '',
      title: r.title,
      start_iso: new Date(startMs).toISOString(),
      end_iso: new Date(endMs).toISOString(),
      location: null, // location is in a separate Location table; future work
      notes: r.notes || null,
      calendar: r.calendar || '',
      all_day: !!r.all_day,
    });
  }
  return out;
}

export function isCalendarDbReadable(): boolean {
  try {
    const db = getDb();
    db.prepare('SELECT 1 FROM CalendarItem LIMIT 1').get();
    return true;
  } catch {
    return false;
  }
}

export interface CalendarListEntry {
  uuid: string;
  title: string;
  /** Hex color in #RRGGBB or #RRGGBBAA form (Apple sometimes appends
   *  an alpha byte). Useful for color-coding the picker. */
  color: string | null;
  /** Best-effort writability hint. true when sharing_status is 0
   *  (user-owned) or 2 (subscribed/shared — most are writable). */
  writable: boolean;
}

/** Enumerate calendars Calendar.app knows about. Used for the
 *  per-proposal "Add to:" dropdown on the chat approval card.
 *
 *  Filters out:
 *  - The literal "Default" placeholder row
 *  - Calendars with null sharing_status (system ones like Birthdays,
 *    Facebook Birthdays, Found in Mail — all read-only)
 *
 *  Duplicates by title can happen when the same calendar syncs from
 *  multiple accounts (e.g. a "Work" calendar via both iCloud and a
 *  CalDAV account). We keep both because they're genuinely different
 *  destinations from Calendar.app's POV. The UI can render the
 *  account name as a subtitle if it helps disambiguate. */
export function listLocalCalendars(): CalendarListEntry[] {
  const db = getDb();
  const rows = db.prepare(`
    SELECT
      UUID            AS uuid,
      title           AS title,
      color           AS color,
      sharing_status  AS sharing_status
    FROM Calendar
    WHERE title IS NOT NULL
      AND title <> 'Default'
      AND sharing_status IS NOT NULL
    ORDER BY display_order ASC, title ASC
  `).all() as Array<{
    uuid: string | null;
    title: string | null;
    color: string | null;
    sharing_status: number | null;
  }>;
  // Dedup exact title+uuid pairs — defensive in case the same row
  // is sourced twice from a join we didn't write. Title alone is NOT
  // a dedup key (see header comment about same-name accounts).
  const seen = new Set<string>();
  const out: CalendarListEntry[] = [];
  for (const r of rows) {
    if (!r.uuid || !r.title) continue;
    const key = `${r.uuid}::${r.title}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      uuid: r.uuid,
      title: r.title,
      color: r.color ? r.color.slice(0, 7) : null,  // strip alpha byte if present
      writable: r.sharing_status === 0 || r.sharing_status === 2,
    });
  }
  return out;
}
