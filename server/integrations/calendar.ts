import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/**
 * Read events from macOS Calendar.app via JXA (JavaScript for Automation).
 *
 * Why this approach:
 *   - Calendar.app already aggregates everything linked in System Settings →
 *     Internet Accounts: iCloud, every Google account, Exchange, CalDAV. We
 *     read Calendar and we get the union. No per-provider OAuth.
 *   - JXA returns structured JSON natively, unlike AppleScript text output.
 *
 * Limitations (be honest):
 *   - Calendar.app's scripting bridge iterates events, not indexed lookups.
 *     A 24h window typically returns in 0.5–2s on a warm cache; first call
 *     after reboot can be 3–5s. The 60s in-memory cache makes the AI draft
 *     hot path tolerable.
 *   - Requires Automation → Calendar grant the first time the LaunchAgent's
 *     Node binary attempts a query. macOS will surface a TCC prompt.
 *   - All-day events have weird date semantics in JXA (start-of-day in the
 *     calendar's TZ); we surface them as `all_day: true` and let the prompt
 *     formatter present them differently.
 */

export interface CalendarEvent {
  /** iCalendar UID — the only stable cross-source identifier. Use this on update/delete. */
  uid: string;
  title: string;
  start_iso: string;
  end_iso: string;
  location: string | null;
  notes: string | null;
  calendar: string;
  all_day: boolean;
}

export interface CalendarSummary {
  name: string;
  writable: boolean;
}

interface CacheEntry {
  expires_at: number;
  events: CalendarEvent[];
}

const CACHE_TTL_MS = 60_000;
const _cache = new Map<string, CacheEntry>();

interface FetchOptions {
  hoursBack?: number;
  hoursAhead?: number;
}

const JXA_SCRIPT = `
function run() {
  const args = $.NSProcessInfo.processInfo.arguments;
  const hoursBack  = parseFloat(ObjC.unwrap(args.objectAtIndex(4))) || 0;
  const hoursAhead = parseFloat(ObjC.unwrap(args.objectAtIndex(5))) || 24;

  const Cal = Application('Calendar');
  Cal.includeStandardAdditions = false;

  const now = new Date();
  const start = new Date(now.getTime() - hoursBack  * 3600 * 1000);
  const end   = new Date(now.getTime() + hoursAhead * 3600 * 1000);

  const out = [];
  const calendars = Cal.calendars();
  for (let i = 0; i < calendars.length; i++) {
    const cal = calendars[i];
    let calName = '';
    try { calName = cal.name(); } catch (e) { calName = '(unnamed)'; }

    let evs;
    try {
      evs = cal.events.whose({
        _and: [
          { startDate: { _greaterThanEquals: start } },
          { startDate: { _lessThan: end } },
        ],
      })();
    } catch (e) { continue; }

    for (let j = 0; j < evs.length; j++) {
      const ev = evs[j];
      try {
        const sd = ev.startDate();
        const ed = ev.endDate();
        let loc = null;
        try { loc = ev.location() || null; } catch (e) {}
        let notes = null;
        try { notes = ev.description() || null; } catch (e) {}
        let allDay = false;
        try { allDay = !!ev.alldayEvent(); } catch (e) {}
        let title = '';
        try { title = ev.summary() || ''; } catch (e) {}
        let uid = '';
        try { uid = ev.uid() || ''; } catch (e) {}
        out.push({
          uid: uid,
          title: title,
          start_iso: sd ? sd.toISOString() : null,
          end_iso:   ed ? ed.toISOString() : null,
          location: loc,
          notes: notes,
          calendar: calName,
          all_day: allDay,
        });
      } catch (e) { /* skip unreadable event */ }
    }
  }
  return JSON.stringify(out);
}
`.trim();

async function fetchEventsViaJxa(hoursBack: number, hoursAhead: number): Promise<CalendarEvent[]> {
  const trimmed = await runJxa(JXA_SCRIPT, String(hoursBack), String(hoursAhead));
  if (!trimmed) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (err) {
    throw new Error(`calendar JXA returned non-JSON: ${trimmed.slice(0, 200)}`);
  }
  if (!Array.isArray(parsed)) return [];
  const events: CalendarEvent[] = [];
  for (const e of parsed as Array<Record<string, unknown>>) {
    if (
      typeof e.start_iso !== 'string' ||
      typeof e.end_iso !== 'string' ||
      typeof e.title !== 'string'
    ) continue;
    events.push({
      uid: typeof e.uid === 'string' ? e.uid : '',
      title: e.title,
      start_iso: e.start_iso,
      end_iso: e.end_iso,
      location: typeof e.location === 'string' && e.location ? e.location : null,
      notes: typeof e.notes === 'string' && e.notes ? e.notes : null,
      calendar: typeof e.calendar === 'string' ? e.calendar : '',
      all_day: !!e.all_day,
    });
  }
  events.sort((a, b) => a.start_iso.localeCompare(b.start_iso));
  return events;
}

export async function getUpcomingEvents(opts: FetchOptions = {}): Promise<CalendarEvent[]> {
  const hoursBack = Math.max(0, Math.min(168, opts.hoursBack ?? 0));
  const hoursAhead = Math.max(0, Math.min(720, opts.hoursAhead ?? 24));
  const cacheKey = `${hoursBack}:${hoursAhead}`;
  const now = Date.now();
  const hit = _cache.get(cacheKey);
  if (hit && hit.expires_at > now) return hit.events;
  const events = await fetchEventsViaJxa(hoursBack, hoursAhead);
  _cache.set(cacheKey, { expires_at: now + CACHE_TTL_MS, events });
  return events;
}

export function clearCalendarCache(): void {
  _cache.clear();
}

/* ------------------------------------------------------------------ */
/* writes — list calendars, create / update / delete events           */
/* ------------------------------------------------------------------ */
//
// Honest scope cuts in V1:
//   - Recurring events: this layer treats them as opaque. Update/delete on a
//     recurring event affects the SERIES via Calendar.app's default behavior;
//     "this instance only" is not exposed yet.
//   - Cross-calendar moves: changing an event's calendar is not supported
//     (would require delete-and-recreate). The caller can do that explicitly.
//   - Attendee management: not exposed. Set the description / notes if you
//     want them visible.
//
// Every write clears the read cache so the next /upcoming reflects the change.

const JXA_LIST_CALENDARS = `
function run() {
  const Cal = Application('Calendar');
  Cal.includeStandardAdditions = false;
  const out = [];
  const calendars = Cal.calendars();
  for (let i = 0; i < calendars.length; i++) {
    const c = calendars[i];
    let name = '';
    try { name = c.name(); } catch (e) {}
    let writable = true;
    try { writable = !!c.writable(); } catch (e) {
      // Older Calendar.app versions don't expose .writable(); assume true and
      // let the create/update fail gracefully if the calendar is read-only.
    }
    out.push({ name: name, writable: writable });
  }
  return JSON.stringify(out);
}
`.trim();

const JXA_CREATE_EVENT = `
function run() {
  const args = $.NSProcessInfo.processInfo.arguments;
  const payload = JSON.parse(ObjC.unwrap(args.objectAtIndex(4)));
  const Cal = Application('Calendar');
  Cal.includeStandardAdditions = false;

  let cal;
  if (payload.calendar) {
    try {
      cal = Cal.calendars.byName(payload.calendar);
      cal.name(); // touch to confirm it resolves
    } catch (e) {
      return JSON.stringify({ error: 'calendar not found: ' + payload.calendar });
    }
  } else {
    try {
      cal = Cal.defaultCalendar();
    } catch (e) {
      return JSON.stringify({ error: 'no default calendar; pass "calendar"' });
    }
  }

  const props = {
    summary: payload.title || '',
    startDate: new Date(payload.start_iso),
    endDate: new Date(payload.end_iso),
  };
  if (payload.location) props.location = payload.location;
  if (payload.notes)    props.description = payload.notes;
  if (payload.all_day)  props.alldayEvent = true;

  let evObj;
  try {
    evObj = Cal.Event(props);
    cal.events.push(evObj);
  } catch (e) {
    return JSON.stringify({ error: 'create failed: ' + e.message });
  }

  let uid = '';
  try { uid = evObj.uid() || ''; } catch (e) {}
  let calName = '';
  try { calName = cal.name(); } catch (e) {}
  return JSON.stringify({ uid: uid, calendar: calName });
}
`.trim();

const JXA_UPDATE_EVENT = `
function run() {
  const args = $.NSProcessInfo.processInfo.arguments;
  const targetUid = ObjC.unwrap(args.objectAtIndex(4));
  const patch = JSON.parse(ObjC.unwrap(args.objectAtIndex(5)));
  const Cal = Application('Calendar');
  Cal.includeStandardAdditions = false;

  const calendars = Cal.calendars();
  for (let i = 0; i < calendars.length; i++) {
    const c = calendars[i];
    let matches;
    try {
      matches = c.events.whose({ uid: { _equals: targetUid } })();
    } catch (e) { continue; }
    if (!matches || matches.length === 0) continue;
    const ev = matches[0];
    try {
      if (patch.title !== undefined) ev.summary = patch.title;
      if (patch.start_iso !== undefined) ev.startDate = new Date(patch.start_iso);
      if (patch.end_iso !== undefined)   ev.endDate   = new Date(patch.end_iso);
      if (patch.location !== undefined)  ev.location  = patch.location || '';
      if (patch.notes !== undefined)     ev.description = patch.notes || '';
      if (patch.all_day !== undefined)   ev.alldayEvent = !!patch.all_day;
    } catch (e) {
      return JSON.stringify({ error: 'update failed: ' + e.message });
    }
    let calName = '';
    try { calName = c.name(); } catch (e) {}
    return JSON.stringify({ uid: targetUid, calendar: calName, updated: true });
  }
  return JSON.stringify({ error: 'event not found: ' + targetUid });
}
`.trim();

const JXA_DELETE_EVENT = `
function run() {
  const args = $.NSProcessInfo.processInfo.arguments;
  const targetUid = ObjC.unwrap(args.objectAtIndex(4));
  const Cal = Application('Calendar');
  Cal.includeStandardAdditions = false;

  const calendars = Cal.calendars();
  for (let i = 0; i < calendars.length; i++) {
    const c = calendars[i];
    let matches;
    try {
      matches = c.events.whose({ uid: { _equals: targetUid } })();
    } catch (e) { continue; }
    if (!matches || matches.length === 0) continue;
    try {
      Cal.delete(matches[0]);
    } catch (e) {
      return JSON.stringify({ error: 'delete failed: ' + e.message });
    }
    return JSON.stringify({ uid: targetUid, deleted: true });
  }
  return JSON.stringify({ error: 'event not found: ' + targetUid });
}
`.trim();

async function runJxa(script: string, ...extraArgs: string[]): Promise<string> {
  const { stdout } = await execFileP(
    'osascript',
    ['-l', 'JavaScript', '-e', script, ...extraArgs],
    { maxBuffer: 8 * 1024 * 1024, timeout: 15_000 },
  );
  return stdout.trim();
}

export async function listCalendars(): Promise<CalendarSummary[]> {
  const stdout = await runJxa(JXA_LIST_CALENDARS);
  if (!stdout) return [];
  const parsed = JSON.parse(stdout);
  if (!Array.isArray(parsed)) return [];
  return (parsed as Array<Record<string, unknown>>)
    .filter((c) => typeof c.name === 'string' && c.name)
    .map((c) => ({ name: c.name as string, writable: !!c.writable }));
}

export interface CreateEventInput {
  title: string;
  start_iso: string;
  end_iso: string;
  location?: string | null;
  notes?: string | null;
  /** Calendar name (from listCalendars). When omitted, uses Calendar.app's default. */
  calendar?: string | null;
  all_day?: boolean;
}

export async function createEvent(
  input: CreateEventInput,
): Promise<{ uid: string; calendar: string }> {
  if (!input.title) throw new Error('title required');
  if (!input.start_iso) throw new Error('start_iso required');
  if (!input.end_iso) throw new Error('end_iso required');
  const payload = {
    title: input.title,
    start_iso: input.start_iso,
    end_iso: input.end_iso,
    location: input.location ?? '',
    notes: input.notes ?? '',
    calendar: input.calendar ?? '',
    all_day: !!input.all_day,
  };
  const stdout = await runJxa(JXA_CREATE_EVENT, JSON.stringify(payload));
  const parsed = JSON.parse(stdout || '{}') as { uid?: string; calendar?: string; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.uid) throw new Error('create returned no uid');
  clearCalendarCache();
  return { uid: parsed.uid, calendar: parsed.calendar ?? '' };
}

export interface UpdateEventInput {
  title?: string;
  start_iso?: string;
  end_iso?: string;
  location?: string | null;
  notes?: string | null;
  all_day?: boolean;
}

export async function updateEvent(
  uid: string,
  patch: UpdateEventInput,
): Promise<{ uid: string; calendar: string }> {
  if (!uid) throw new Error('uid required');
  const stdout = await runJxa(JXA_UPDATE_EVENT, uid, JSON.stringify(patch));
  const parsed = JSON.parse(stdout || '{}') as {
    uid?: string;
    calendar?: string;
    updated?: boolean;
    error?: string;
  };
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.updated) throw new Error('event not updated');
  clearCalendarCache();
  return { uid: parsed.uid ?? uid, calendar: parsed.calendar ?? '' };
}

export async function deleteEvent(uid: string): Promise<void> {
  if (!uid) throw new Error('uid required');
  const stdout = await runJxa(JXA_DELETE_EVENT, uid);
  const parsed = JSON.parse(stdout || '{}') as { deleted?: boolean; error?: string };
  if (parsed.error) throw new Error(parsed.error);
  if (!parsed.deleted) throw new Error('event not deleted');
  clearCalendarCache();
}

/* ------------------------------------------------------------------ */
/* prompt-formatting helpers                                          */
/* ------------------------------------------------------------------ */

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '?';
  let h = d.getHours();
  const m = d.getMinutes();
  const ap = h >= 12 ? 'PM' : 'AM';
  h = h % 12;
  if (h === 0) h = 12;
  return m === 0 ? `${h} ${ap}` : `${h}:${String(m).padStart(2, '0')} ${ap}`;
}

function fmtDay(iso: string, todayY: number, todayM: number, todayD: number): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return '?';
  const y = d.getFullYear();
  const m = d.getMonth();
  const day = d.getDate();
  if (y === todayY && m === todayM && day === todayD) return 'Today';
  const tomorrow = new Date(todayY, todayM, todayD + 1);
  if (y === tomorrow.getFullYear() && m === tomorrow.getMonth() && day === tomorrow.getDate()) {
    return 'Tomorrow';
  }
  return `${DOW[d.getDay()]} ${MON[m]} ${day}`;
}

/**
 * Format event list as a compact prompt block. Empty string when no events.
 * Example output:
 *   Today (Wed Mar 12):
 *   - 10:30 AM – 11 AM: Standup (Work)
 *   - 2 PM – 3 PM: Coffee w/ Mike
 *   Tomorrow:
 *   - All day: Flight LAX → JFK
 */
export function formatAvailabilityContext(events: CalendarEvent[]): string {
  if (events.length === 0) return '';
  const now = new Date();
  const ty = now.getFullYear();
  const tm = now.getMonth();
  const td = now.getDate();

  const groups = new Map<string, CalendarEvent[]>();
  for (const ev of events) {
    const day = fmtDay(ev.start_iso, ty, tm, td);
    const list = groups.get(day);
    if (list) list.push(ev);
    else groups.set(day, [ev]);
  }

  const lines: string[] = [];
  for (const [day, evs] of groups) {
    lines.push(`${day}:`);
    for (const ev of evs) {
      const loc = ev.location ? ` @ ${ev.location}` : '';
      if (ev.all_day) {
        lines.push(`- All day: ${ev.title}${loc}`);
      } else {
        lines.push(`- ${fmtTime(ev.start_iso)} – ${fmtTime(ev.end_iso)}: ${ev.title}${loc}`);
      }
    }
  }
  return lines.join('\n');
}
