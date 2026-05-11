// Galt-chat tools — function-calling registry.
//
// Each entry is one tool Galt can call mid-conversation. Tools wrap
// the existing read paths (chat.db, app.db, AddressBook, Calendar,
// CallHistory.storedata) — no new write surfaces. Read-only by design;
// per the user, "no guard rails" applies to *visibility* (Galt can
// read everything you can), not to actions on your account.
//
// Conventions:
//   - Every tool returns a JSON-serializable object. Strings are fine
//     too but objects make it easier to debug + display.
//   - Tools never throw on "no data" — they return { items: [] } or
//     similar so the model knows the lookup succeeded but came back
//     empty. They DO throw on real failures (db unreachable, bad
//     args) — the runner catches and reports back to the model.
//   - Tools format dates as Unix ms so the model can reason about
//     time consistently with the rest of the system.
//   - Tools cap output sizes. The model has a tight context window;
//     returning 500 messages is wasteful. Sensible defaults + a
//     `limit` arg the model can override.

import type { ToolDefinition } from './client.js';
import { getUpcomingEvents } from '../integrations/calendar.js';
import { listRecentCalls } from '../integrations/call-history.js';
import {
  appleDateToUnixMs,
  getChatDb,
  listRecentMessages,
  getMaxMessageRowid,
} from '../db/messages.js';
import {
  getContactByHandle,
  getContactNameForHandle,
  listContactsWithHandles,
  normalizeHandle,
} from '../db/contacts.js';
import {
  listAutoNotes,
  listNotesForHandle,
  getContactProfile,
} from '../db/app.js';

/* ============================================================
   Calendar
   ============================================================ */

const list_calendar_events: ToolDefinition = {
  name: 'list_calendar_events',
  description:
    "Read the user's macOS Calendar. Returns events in a time window — defaults to the next 7 days. Use this for any question about the user's schedule, upcoming meetings, what they have today/tomorrow/this week, or whether a specific date is free.",
  parameters: {
    type: 'object',
    properties: {
      hours_ahead: {
        type: 'number',
        description: 'How many hours into the future to look. Defaults to 168 (7 days).',
      },
      hours_back: {
        type: 'number',
        description: 'How many hours backwards to look. Defaults to 0 (only future events).',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const hoursAhead = typeof args.hours_ahead === 'number' ? args.hours_ahead : 24 * 7;
    const hoursBack  = typeof args.hours_back  === 'number' ? args.hours_back  : 0;
    const events = await getUpcomingEvents({ hoursAhead, hoursBack });
    return {
      window: { hours_back: hoursBack, hours_ahead: hoursAhead },
      count: events.length,
      events: events.map((e) => ({
        uid: e.uid,
        title: e.title,
        start_iso: e.start_iso,
        end_iso: e.end_iso,
        location: e.location,
        notes: e.notes,
        calendar: e.calendar,
        all_day: e.all_day,
      })),
    };
  },
};

/* ============================================================
   Messages
   ============================================================ */

const search_messages: ToolDefinition = {
  name: 'search_messages',
  description:
    "Full-text search the user's iMessage / SMS history (chat.db). Returns messages containing the query string, newest first. Use this for 'what did X say about Y', 'find that message about Z', 'last time I talked about W'.",
  parameters: {
    type: 'object',
    required: ['query'],
    properties: {
      query: {
        type: 'string',
        description: 'Substring to search for in message bodies (case-insensitive, min 2 chars).',
      },
      limit: {
        type: 'number',
        description: 'Max results to return. Default 30, capped at 200.',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const q = typeof args.query === 'string' ? args.query.trim() : '';
    if (q.length < 2) throw new Error('query must be at least 2 chars');
    const limit = Math.max(1, Math.min(200, typeof args.limit === 'number' ? args.limit : 30));
    const db = getChatDb();
    const rows = db.prepare(`
      SELECT
        m.ROWID           AS id,
        m.text            AS text,
        h.id              AS handle,
        m.date            AS date,
        m.is_from_me      AS is_from_me,
        m.service         AS service,
        cmj.chat_id       AS chat_id,
        c.display_name    AS chat_display_name,
        c.chat_identifier AS chat_identifier
      FROM message m
      LEFT JOIN handle h ON h.ROWID = m.handle_id
      LEFT JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
      LEFT JOIN chat c ON c.ROWID = cmj.chat_id
      WHERE m.text LIKE ?
        AND (m.associated_message_type IS NULL OR m.associated_message_type = 0)
      ORDER BY m.date DESC
      LIMIT ?
    `).all(`%${q.replace(/[%_]/g, (m) => '\\' + m)}%`, limit) as Array<{
      id: number;
      text: string | null;
      handle: string | null;
      date: number | bigint | null;
      is_from_me: number;
      service: string | null;
      chat_id: number | null;
      chat_display_name: string | null;
      chat_identifier: string | null;
    }>;

    return {
      query: q,
      count: rows.length,
      messages: rows.map((r) => ({
        id: r.id,
        text: r.text,
        handle: r.handle,
        contact_name: r.is_from_me ? null : getContactNameForHandle(r.handle),
        date_ms: appleDateToUnixMs(r.date),
        is_from_me: !!r.is_from_me,
        service: r.service,
        chat_id: r.chat_id,
        chat_display_name: r.chat_display_name,
      })),
    };
  },
};

const list_recent_messages: ToolDefinition = {
  name: 'list_recent_messages',
  description:
    'List the most recent iMessage / SMS messages across all chats, newest first. Reactions are filtered out. Useful for "what came in lately" / "anything new" questions.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max messages to return. Default 30, capped at 200.',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const limit = Math.max(1, Math.min(200, typeof args.limit === 'number' ? args.limit : 30));
    const max = getMaxMessageRowid();
    // listRecentMessages returns ascending by rowid; we want newest
    // first, so reverse before slicing to limit.
    const rows = listRecentMessages(0, 500).reverse().slice(0, limit);
    return {
      max_rowid: max,
      count: rows.length,
      messages: rows.map((r) => ({
        id: r.id,
        text: r.text,
        handle: r.handle,
        contact_name: r.contact_name || null,
        date_ms: r.date_ms,
        is_from_me: !!r.is_from_me,
        service: r.service,
        chat_id: r.chat_id,
      })),
    };
  },
};

/* ============================================================
   Auto-notes (AI-extracted follow-up queue)
   ============================================================ */

const list_auto_notes: ToolDefinition = {
  name: 'list_auto_notes',
  description:
    "Read the user's AI-extracted follow-up queue. These are inbound messages flagged as substantive (meet requests, decisions, time-sensitive items, important news). Use this for questions about 'what do I need to follow up on', 'who's waiting on me', 'what's pending'.",
  parameters: {
    type: 'object',
    properties: {
      reviewed: {
        type: 'boolean',
        description: 'If false, only unreviewed (open follow-ups). If true, only reviewed. Omit for both.',
      },
      limit: {
        type: 'number',
        description: 'Max notes to return. Default 50, capped at 200.',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const limit = Math.max(1, Math.min(200, typeof args.limit === 'number' ? args.limit : 50));
    const opts: { reviewed?: boolean; limit: number } = { limit };
    if (typeof args.reviewed === 'boolean') opts.reviewed = args.reviewed;
    const notes = listAutoNotes(opts);
    return {
      count: notes.length,
      notes: notes.map((n) => ({
        id: n.id,
        handle: n.handle,
        contact_name: getContactNameForHandle(n.handle),
        category: n.category,
        summary: n.summary,
        reasoning: n.reasoning,
        message_text: n.message_text,
        created_at_ms: n.created_at,
        reviewed_at_ms: n.reviewed_at,
      })),
    };
  },
};

/* ============================================================
   Contacts
   ============================================================ */

const get_contact: ToolDefinition = {
  name: 'get_contact',
  description:
    "Look up a contact in the user's AddressBook by name or handle (phone/email). Returns the contact's full record including their handles, organization, job title, and any free-form notes the user has typed. Use this when the user mentions a person by name and you need their details, or when you have a handle and want to know who it belongs to.",
  parameters: {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description: 'Full or partial name to search for (case-insensitive).',
      },
      handle: {
        type: 'string',
        description: 'Phone number or email address. Will be normalized.',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const handleRaw = typeof args.handle === 'string' ? args.handle : '';
    const name = typeof args.name === 'string' ? args.name.trim().toLowerCase() : '';

    if (handleRaw) {
      const handle = normalizeHandle(handleRaw);
      const info = getContactByHandle(handle);
      return {
        query_kind: 'handle',
        query: handle,
        match: info ? formatContact(info, [handle]) : null,
      };
    }
    if (!name) throw new Error('name or handle required');

    // Name search — scan all contacts. The list is in-memory so this is fast.
    const all = listContactsWithHandles();
    const matches = all
      .filter((c) => c.full_name.toLowerCase().includes(name))
      .slice(0, 10)
      .map((c) => formatContact(c, c.handles));

    return {
      query_kind: 'name',
      query: name,
      count: matches.length,
      matches,
    };
  },
};

function formatContact(
  info: {
    full_name: string;
    first_name: string | null;
    last_name: string | null;
    organization: string | null;
    job_title: string | null;
    notes: string | null;
    birthday: string | null;
  },
  handles: string[],
) {
  return {
    full_name: info.full_name,
    first_name: info.first_name,
    last_name: info.last_name,
    organization: info.organization,
    job_title: info.job_title,
    notes: info.notes,
    birthday: info.birthday,
    handles,
  };
}

const list_contact_notes: ToolDefinition = {
  name: 'list_contact_notes',
  description:
    "Read the user's free-form notes about a specific contact (notes typed in the Galt UI's per-contact memory bank). Optional handle filter — if omitted, fails (we need to know who). Pair with get_contact to resolve a name to a handle first.",
  parameters: {
    type: 'object',
    required: ['handle'],
    properties: {
      handle: {
        type: 'string',
        description: 'Phone number or email of the contact.',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const handleRaw = typeof args.handle === 'string' ? args.handle : '';
    if (!handleRaw) throw new Error('handle required');
    const handle = normalizeHandle(handleRaw);
    const notes = listNotesForHandle(handle);
    const profile = getContactProfile(handle);
    return {
      handle,
      contact_name: getContactNameForHandle(handle),
      profile: profile.profile || null,
      profile_updated_at_ms: profile.updated_at || null,
      count: notes.length,
      notes: notes.map((n) => ({ id: n.id, body: n.body, created_at_ms: n.created_at })),
    };
  },
};

/* ============================================================
   Call history
   ============================================================ */

const get_call_history: ToolDefinition = {
  name: 'get_call_history',
  description:
    "Read the user's macOS call history (phone + FaceTime). Returns recent calls, newest first, optionally filtered by contact name or number. Use for 'who called me yesterday', 'did I miss any calls', 'when was my last call with X'.",
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max calls to return. Default 30, capped at 200.',
      },
      since_ms: {
        type: 'number',
        description: 'Only calls newer than this Unix ms.',
      },
      match: {
        type: 'string',
        description: 'Optional substring to match against the name or address (phone/email).',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const limit = Math.max(1, Math.min(200, typeof args.limit === 'number' ? args.limit : 30));
    const sinceMs = typeof args.since_ms === 'number' ? args.since_ms : undefined;
    const match   = typeof args.match    === 'string' ? args.match    : undefined;
    const calls = listRecentCalls({ limit, sinceMs, match });
    return {
      count: calls.length,
      calls,
    };
  },
};

/* ============================================================
   Public registry
   ============================================================ */

/** Every tool Galt can call from the direct-chat surface. Order
 *  doesn't matter to the model but mirrors complexity (simple ↔
 *  complex) for readability when scanning the source. */
export const CHAT_TOOLS: ToolDefinition[] = [
  list_calendar_events,
  search_messages,
  list_recent_messages,
  list_auto_notes,
  get_contact,
  list_contact_notes,
  get_call_history,
];
