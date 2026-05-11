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
  ics_path: string;
}

/** Resolve a proposal, write its .ics to a temp file, hand off to
 *  Calendar.app via `open`, then mark the proposal exported. Throws
 *  with a human-readable message on any failure; callers translate
 *  to HTTP / RTDB result shapes. */
export async function exportCalendarProposal(id: number): Promise<ExportProposalResult> {
  const p = getCalendarProposal(id);
  if (!p) throw new Error('not found');
  if (!p.start_ms) {
    throw new Error('proposal has no start time — edit it first or dismiss');
  }
  const startMs = p.start_ms;
  // Default end: +1 hour if not specified.
  const endMs = p.end_ms ?? startMs + 60 * 60 * 1000;
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
  return { proposal: enrichProposal(updated!), ics_path: tmpPath };
}

/** Mark a proposal dismissed. Thin wrapper for parity with the
 *  export path so both verbs flow through here. */
export function dismissCalendarProposal(id: number): ExportProposalResult['proposal'] {
  const updated = updateCalendarProposalStatus(id, 'dismissed');
  if (!updated) throw new Error('not found');
  return enrichProposal(updated);
}
