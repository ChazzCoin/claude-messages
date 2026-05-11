// Calendar-proposal export helper.
//
// Writes a calendar_proposals row to disk as an .ics file and opens
// it with the system `open` command — Calendar.app's native importer
// pops up, the user reviews, hits Add. Sidesteps AppleEvents (which
// stall from a LaunchAgent context on macOS 14+, see calendar-db.ts).
//
// Lives in its own file (not index.ts) so the RTDB command listener
// in firebase-commands.ts can call it without producing a circular
// import — index.ts imports firebase-commands for boot, and we don't
// want the reverse.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import {
  getCalendarProposal,
  updateCalendarProposalStatus,
  type CalendarProposal,
} from './db/app.js';
import { getContactNameForHandle } from './db/contacts.js';
import { createEvent } from './integrations/calendar.js';
import { listLocalCalendars } from './integrations/calendar-db.js';

const execFileP = promisify(execFile);

export function enrichProposal<T extends { handle: string }>(
  p: T,
): T & { contact_name: string | null } {
  return { ...p, contact_name: getContactNameForHandle(p.handle) };
}

interface BuildIcsInput {
  uid: string;
  title: string;
  startMs: number;
  endMs: number;
  location: string | null;
  description: string;
  /** Optional: name of the destination calendar in Calendar.app.
   *  Stamped as X-WR-CALNAME at the VCALENDAR level — Calendar.app's
   *  import dialog uses this as a hint for the "Calendar:" dropdown.
   *  When null, no hint; Calendar.app uses its own default. */
  calendarName?: string | null;
}

export function buildIcs(input: BuildIcsInput): string {
  const fmt = (ms: number): string => {
    const d = new Date(ms);
    const yyyy = d.getUTCFullYear();
    const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(d.getUTCDate()).padStart(2, '0');
    const HH = String(d.getUTCHours()).padStart(2, '0');
    const MM = String(d.getUTCMinutes()).padStart(2, '0');
    const SS = String(d.getUTCSeconds()).padStart(2, '0');
    return `${yyyy}${mm}${dd}T${HH}${MM}${SS}Z`;
  };
  const escape = (s: string) =>
    s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/,/g, '\\,').replace(/;/g, '\\;');
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//galt//EN',
  ];
  if (input.calendarName) {
    lines.push(`X-WR-CALNAME:${escape(input.calendarName)}`);
  }
  lines.push(
    'BEGIN:VEVENT',
    `UID:${input.uid}`,
    `DTSTAMP:${fmt(Date.now())}`,
    `DTSTART:${fmt(input.startMs)}`,
    `DTEND:${fmt(input.endMs)}`,
    `SUMMARY:${escape(input.title)}`,
  );
  if (input.location) lines.push(`LOCATION:${escape(input.location)}`);
  if (input.description) lines.push(`DESCRIPTION:${escape(input.description)}`);
  lines.push('END:VEVENT', 'END:VCALENDAR');
  return lines.join('\r\n') + '\r\n';
}

export interface ExportProposalResult {
  proposal: CalendarProposal & { contact_name: string | null };
  /** How the export landed:
   *   'direct'  — silent JXA write to Calendar.app, no dialog
   *   'ics'     — .ics file + `open`, macOS importer dialog shown
   *   'error'   — both paths failed
   *  Surfaced to the UI so we can give honest feedback ("added!" vs
   *  "opened in Calendar — confirm there"). */
  method: 'direct' | 'ics' | 'error';
  /** Calendar.app event UID when the direct write succeeded. */
  event_uid?: string;
  /** Path of the .ics file when we fell back to the ics path. */
  ics_path?: string;
  /** Error message if direct write failed — explains why we fell
   *  back. */
  direct_error?: string;
}

/** Resolve a proposal and add it to Calendar.app.
 *
 *  Primary path: direct JXA write via createEvent(). Silent — no
 *  importer dialog. Works only when the user has granted Automation
 *  → Calendar AND Calendar privacy (Full Access) to the Node binary.
 *  Single-shot writes don't hang the way calendar enumeration does
 *  in a LaunchAgent context (tested empirically).
 *
 *  Fallback path: write .ics to a temp file, `open` it. macOS shows
 *  the system "Add Event" dialog and the user clicks Add. Slower
 *  UX but works without any Automation grant.
 *
 *  Either way, the proposal is marked status='exported' on success.
 *  Throws on hard failure (proposal not found, missing start, etc). */
export async function exportCalendarProposal(id: number): Promise<ExportProposalResult> {
  const p = getCalendarProposal(id);
  if (!p) throw new Error('not found');
  if (!p.start_ms) {
    throw new Error('proposal has no start time — edit it first or dismiss');
  }
  const startMs = p.start_ms;
  // Default end: +1 hour if not specified.
  const endMs = p.end_ms ?? startMs + 60 * 60 * 1000;

  // ---- 1) try direct write (silent) ----
  // Calendar.app's defaultCalendar() doesn't resolve in a LaunchAgent
  // context. Build a candidate list:
  //   - if the user picked one on the card, try it first.
  //   - then try sqlite-listed user-owned calendars in order. Their
  //     titles don't always match Calendar.app's calendars (some
  //     sqlite rows are account containers, not actual calendars),
  //     so we retry through several until one accepts the write.
  //   - dedup by title to avoid spamming the same name twice.
  const candidates: string[] = [];
  if (p.target_calendar) candidates.push(p.target_calendar);
  try {
    for (const c of listLocalCalendars()) {
      if (!c.writable || !c.title) continue;
      if (candidates.includes(c.title)) continue;
      candidates.push(c.title);
    }
  } catch {
    // proceed with whatever we have
  }

  let directError: string | undefined;
  let directUid: string | undefined;
  for (const candidate of candidates) {
    try {
      const out = await createEvent({
        title: p.title,
        start_iso: new Date(startMs).toISOString(),
        end_iso: new Date(endMs).toISOString(),
        location: p.location,
        notes: [p.notes, p.participants ? `Participants: ${p.participants}` : null]
          .filter(Boolean)
          .join('\n\n'),
        calendar: candidate,
      });
      directUid = out.uid;
      directError = undefined;
      break;
    } catch (err) {
      directError = (err as Error).message;
      // Specific error patterns we should give up on retrying:
      // - "calendar is read only" → calendar exists but won't accept writes → next candidate
      // - "calendar not found: X" → next candidate
      // - everything else (e.g. AppleEvent hang, perms denied) → stop trying
      const retryable =
        /calendar is read only/i.test(directError) ||
        /calendar not found/i.test(directError);
      if (!retryable) break;
    }
  }

  if (directUid) {
    const updated = updateCalendarProposalStatus(id, 'exported');
    return {
      proposal: enrichProposal(updated!),
      method: 'direct',
      event_uid: directUid,
    };
  }
  if (directError) {
    console.warn(`[calendar-export] direct write failed (id=${id}, candidates=${candidates.length}): ${directError}; falling back to .ics`);
  }

  // ---- 2) fallback to .ics + open (dialog) ----
  try {
    const ics = buildIcs({
      uid: `galt-${p.id}-${Date.now()}@local`,
      title: p.title,
      startMs,
      endMs,
      location: p.location,
      description: [p.notes, p.participants ? `Participants: ${p.participants}` : null]
        .filter(Boolean)
        .join('\n\n'),
      calendarName: p.target_calendar,
    });
    const tmpPath = path.join(os.tmpdir(), `galt-event-${id}.ics`);
    fs.writeFileSync(tmpPath, ics, 'utf8');
    await execFileP('open', [tmpPath]);
    const updated = updateCalendarProposalStatus(id, 'exported');
    return {
      proposal: enrichProposal(updated!),
      method: 'ics',
      ics_path: tmpPath,
      direct_error: directError,
    };
  } catch (icsErr) {
    // Both paths failed. Don't mark as exported — leave status pending
    // so the user can retry.
    throw new Error(
      `direct write failed (${directError}); .ics fallback also failed (${(icsErr as Error).message})`,
    );
  }
}

/** Mark a proposal dismissed. Thin wrapper for parity with the
 *  export path so both verbs flow through here. */
export function dismissCalendarProposal(id: number): ExportProposalResult['proposal'] {
  const updated = updateCalendarProposalStatus(id, 'dismissed');
  if (!updated) throw new Error('not found');
  return enrichProposal(updated);
}
