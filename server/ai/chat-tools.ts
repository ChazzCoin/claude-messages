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
import { listEventsInWindow } from '../integrations/calendar-db.js';
import { listRecentCalls } from '../integrations/call-history.js';
import { insertChatCalendarProposal } from '../db/app.js';
import { claudeCli } from '../integrations/claude-cli.js';
import { startClaudeTask } from '../task-runner.js';
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
  listGChatSpaces,
  listGChatMessages,
  searchGChatMessages,
} from '../db/app.js';
import { googleChat } from '../integrations/google-chat.js';

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
    // Read from Calendar.app's local sqlite cache. Bypasses
    // AppleEvents which silently stall in a LaunchAgent context on
    // macOS 14+.
    const events = listEventsInWindow({ hoursAhead, hoursBack });
    return {
      window: { hours_back: hoursBack, hours_ahead: hoursAhead },
      count: events.length,
      events,
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
   Write-with-approval — propose a calendar event
   ============================================================
   This is a structured-output WRITE proposal, not a direct write.
   Galt fills in the fields via the tool's strict args schema
   (OpenAI validates before we even see the call); we re-validate
   server-side; the row lands in `calendar_proposals` with
   status='pending'. The chat UI then renders an approval card that
   the user has to tap before anything touches Calendar.app. Same
   queue as the inbound-message extraction flow — the existing
   /api/calendar/proposals/:id/export and /dismiss endpoints handle
   approve / reject.

   Galt should call this tool whenever the user asks to schedule /
   add / create an event. Never makes a write itself. */

function buildProposeCalendarEventTool(galtMessageId: string): ToolDefinition {
  return {
    name: 'propose_calendar_event',
    description:
      "Propose a calendar event for the user to review. Use this whenever the user asks you to schedule, add, or create an event/meeting/appointment. You parse the fields from their request; the user reviews and approves before anything is written to Calendar.app. Today's date is in the system context — resolve relative phrases (tomorrow, Friday, next week) to absolute ISO times in the user's local timezone. If anything is genuinely ambiguous, ask the user instead of guessing.",
    parameters: {
      type: 'object',
      required: ['title', 'start_iso', 'end_iso', 'location', 'participants', 'notes'],
      properties: {
        title: {
          type: 'string',
          description: 'Concise event title in the user\'s voice. E.g. "Lunch with Sarah" not "Have lunch with Sarah".',
        },
        start_iso: {
          type: 'string',
          description: 'Start in local-time ISO format YYYY-MM-DDTHH:MM, e.g. "2026-05-14T15:00".',
        },
        end_iso: {
          type: ['string', 'null'],
          description: 'End in YYYY-MM-DDTHH:MM, or null. Default duration is 1 hour if you don\'t know.',
        },
        location: {
          type: ['string', 'null'],
          description: 'Physical address, video-call URL, or place name. Null if unspecified.',
        },
        participants: {
          type: ['string', 'null'],
          description: 'Comma-separated list of attendees, or null. Doesn\'t send invites — purely descriptive.',
        },
        notes: {
          type: 'string',
          description: 'One-sentence context for the event. Becomes the event description.',
        },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const title = typeof args.title === 'string' ? args.title.trim() : '';
      if (!title) throw new Error('title required');
      const startIsoRaw = typeof args.start_iso === 'string' ? args.start_iso.trim() : '';
      if (!startIsoRaw) throw new Error('start_iso required');
      const startMs = Date.parse(startIsoRaw);
      if (!Number.isFinite(startMs)) throw new Error(`start_iso is not a valid date: "${startIsoRaw}"`);

      let endMs: number | null = null;
      if (typeof args.end_iso === 'string' && args.end_iso.trim()) {
        const parsed = Date.parse(args.end_iso.trim());
        if (Number.isFinite(parsed)) {
          endMs = parsed > startMs ? parsed : null;
        }
      }

      const location = typeof args.location === 'string' && args.location.trim() ? args.location.trim() : null;
      const participants = typeof args.participants === 'string' && args.participants.trim() ? args.participants.trim() : null;
      const notes = typeof args.notes === 'string' ? args.notes.trim() : '';

      const proposal = insertChatCalendarProposal({
        galt_message_id: galtMessageId,
        title,
        start_ms: startMs,
        end_ms: endMs,
        location,
        participants,
        notes: notes || null,
        confidence: 0.95,  // user explicitly asked, so high
        reasoning: 'user_request_via_galt_chat',
      });

      if (!proposal) {
        // INSERT OR IGNORE returned no row — a proposal with this
        // source_msg_guid already exists. Surface that so Galt can
        // tell the user.
        return {
          ok: false,
          error: 'a proposal for this chat turn already exists',
        };
      }

      // Embed the rendered card in the result so the chat UI can
      // surface an approve/dismiss control without re-fetching.
      // The model also sees this and can phrase its reply around it.
      return {
        ok: true,
        proposal_id: proposal.id,
        title: proposal.title,
        start_iso: proposal.start_ms ? new Date(proposal.start_ms).toISOString() : null,
        end_iso: proposal.end_ms ? new Date(proposal.end_ms).toISOString() : null,
        location: proposal.location,
        participants: proposal.participants,
        notes: proposal.notes,
        next_step: 'Tell the user briefly what you drafted and that they need to tap Approve to add it to Calendar.',
      };
    },
  };
}

/* ============================================================
   Generic user-approval request
   ============================================================
   Galt calls this when it wants an explicit yes/no from the user
   *before* doing something. The tool itself has no side effect —
   it just stamps the question + labels on the current turn's
   tool_calls record. The companion + web chat surfaces render
   that record as a card with Approve / Deny buttons. The user's
   click sends the chosen label as a normal user chat turn so
   Galt sees the decision on the next round and acts on it.

   When to use:
   - About to do something irreversible / hard to undo
   - User's ask is ambiguous between two paths
   - Galt wants to confirm a non-obvious assumption before
     proceeding (e.g. "I'll use Sarah's work email — that ok?")

   When NOT to use:
   - The user is asking a question and just wants an answer
   - Galt has enough information to just proceed
   - The action is already gated by another proposal card
     (e.g. propose_calendar_event already has its own Approve
     button — don't double-gate). */

const request_user_approval: ToolDefinition = {
  name: 'request_user_approval',
  description:
    "Ask the user for an explicit yes/no decision before taking an action. The chat UI renders inline Approve / Deny buttons; the user's click flows back as their next message so you see the decision on the next round. Use sparingly — only when you genuinely need a Y/N from the user before continuing. After calling, your natural-language reply should be brief: state what you're asking about and tell the user to tap one of the buttons.",
  parameters: {
    type: 'object',
    required: ['question'],
    properties: {
      question: {
        type: 'string',
        description: 'Short, direct question for the user. Phrase it so Approve = "yes, go ahead" and Deny = "no, do not". Examples: "Send this draft now?", "Delete the note about Sarah?", "Use the work email instead of personal?".',
      },
      context: {
        type: 'string',
        description: 'Optional one-sentence context shown below the question. Use when the question alone is ambiguous. Keep it short — full reasoning goes in your natural-language reply, not here.',
      },
      approve_label: {
        type: 'string',
        description: 'Optional label for the Approve button. Default "Approve". Use specific verbs for non-Y/N choices, e.g. "Use work email" vs "Use personal email".',
      },
      deny_label: {
        type: 'string',
        description: 'Optional label for the Deny button. Default "Deny". Pair with approve_label for non-Y/N choices.',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const question = typeof args.question === 'string' ? args.question.trim() : '';
    if (!question) throw new Error('question required');
    return {
      ok: true,
      question,
      context: typeof args.context === 'string' && args.context.trim() ? args.context.trim() : null,
      approve_label: typeof args.approve_label === 'string' && args.approve_label.trim() ? args.approve_label.trim() : 'Approve',
      deny_label: typeof args.deny_label === 'string' && args.deny_label.trim() ? args.deny_label.trim() : 'Deny',
      next_step: "Tell the user briefly what you're asking and that they need to tap Approve or Deny. Wait for their response in the next turn before acting.",
    };
  },
};

/* ============================================================
   Claude CLI delegation (Phase 1)
   ============================================================
   Galt routes to Claude Code when a request exceeds its built-in
   tools — filesystem ops, code work, web research, anything CLI-
   accessible on the Mac. Synchronous in Phase 1 (Galt waits for
   Claude to finish); a streaming task layer is Phase 2/3. */

/* ============================================================
   Google Chat
   ============================================================ */

const list_gchat_spaces: ToolDefinition = {
  name: 'list_gchat_spaces',
  description:
    "List all Google Chat spaces the user is a member of, including which ones are being monitored. Use this when the user asks about their Google Chat spaces, wants to know what's being watched, or before sending a message to confirm the correct space name.",
  parameters: { type: 'object', properties: {}, required: [] },
  async execute() {
    const spaces = listGChatSpaces();
    return {
      spaces: spaces.map((s) => ({
        name: s.name,
        display_name: s.display_name,
        space_type: s.space_type,
        watched: s.watched === 1,
        last_message_time: s.last_message_time,
      })),
    };
  },
};

const list_gchat_messages: ToolDefinition = {
  name: 'list_gchat_messages',
  description:
    'Read recent messages from a Google Chat space. Use this when the user asks what was discussed in a space, wants to catch up on a conversation, or needs context before sending a message.',
  parameters: {
    type: 'object',
    properties: {
      space_name: {
        type: 'string',
        description: 'The space resource name, e.g. "spaces/XXXXXXX". Get this from list_gchat_spaces.',
      },
      limit: {
        type: 'number',
        description: 'Max messages to return (default 50, max 200).',
      },
    },
    required: ['space_name'],
  },
  async execute(args: { space_name: string; limit?: number }) {
    const limit = Math.max(1, Math.min(200, args.limit ?? 50));
    const messages = listGChatMessages(args.space_name, { limit });
    return { messages: messages.reverse() }; // oldest first for readability
  },
};

const send_gchat_message: ToolDefinition = {
  name: 'send_gchat_message',
  description:
    "Send a message to a Google Chat space. Use this when the user explicitly asks to send a message, post a standup, share an update, or reply to a space. Always confirm the text with the user before sending unless they've provided the exact message to send.",
  parameters: {
    type: 'object',
    properties: {
      space_name: {
        type: 'string',
        description: 'The space resource name, e.g. "spaces/XXXXXXX".',
      },
      text: {
        type: 'string',
        description: 'The message text to send.',
      },
    },
    required: ['space_name', 'text'],
  },
  async execute(args: { space_name: string; text: string }) {
    const msg = await googleChat.sendMessage(args.space_name, args.text);
    return { ok: true, message: { name: msg.name, text: msg.text, create_time: msg.createTime } };
  },
};

const search_gchat_messages: ToolDefinition = {
  name: 'search_gchat_messages',
  description:
    'Search through Google Chat message history by keyword. Searches across all spaces unless space_name is provided. Use for finding specific conversations, decisions, or context.',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Keyword or phrase to search for.' },
      space_name: { type: 'string', description: 'Optional: limit to a specific space.' },
    },
    required: ['query'],
  },
  async execute(args: { query: string; space_name?: string }) {
    const messages = searchGChatMessages(args.query, args.space_name);
    return { messages };
  },
};

/** Build the claude_ask tool for a specific Galt chat turn. The
 *  message id stamps the resulting task row so the chat UI can
 *  render a live task card tied to this exact Galt turn. */
function buildClaudeAskTool(galtMessageId: string): ToolDefinition {
  return {
    name: 'claude_ask',
    description:
      "Delegate a task to Claude Code (running on this Mac) when the request needs filesystem access, shell commands, code work, web search/fetch, or anything outside your built-in read/write tools. Examples: 'find the receipt PDF in ~/Downloads', 'why is the watcher dropping reactions', 'summarize these 5 markdown files', 'what's the latest OpenAI model'. Claude can read/write files, run commands, and search the web. AVOID for things your built-in tools cover (calendar, messages, contacts, call history, auto-notes).\n\nIMPORTANT: this tool RETURNS IMMEDIATELY with a task_id — Claude runs in the background. The chat UI renders a live progress card; you do NOT see Claude's reply in your tool result. Your follow-up reply should be brief — confirm you delegated the task and let the user know to watch the card below your message. Do NOT pretend to have an answer; the card IS the answer.",
    parameters: {
      type: 'object',
      required: ['task'],
      properties: {
        task: {
          type: 'string',
          description: 'The specific task for Claude. Write it like a one-paragraph brief: what to do, where, what to return. Be concrete.',
        },
        working_dir: {
          type: 'string',
          description: "Optional absolute path to the directory Claude should work in. ONLY pass this if the user explicitly mentioned a specific path or you've previously confirmed it exists via another tool. DO NOT invent paths — if you're unsure, omit this and let it default to the Galt project root.",
        },
        allowed_tools: {
          type: 'array',
          items: { type: 'string' },
          description: 'Restrict Claude\'s tool surface. Examples: ["Read","WebSearch","WebFetch"] for read-only browse, or ["Bash"] for shell-only. Omit to let Claude use its full toolset.',
        },
        max_budget_usd: {
          type: 'number',
          description: 'Hard cap on dollars spent on this task.',
        },
      },
      additionalProperties: false,
    },
    async execute(args) {
      const task = typeof args.task === 'string' ? args.task.trim() : '';
      if (!task) throw new Error('task required');
      const workingDir = typeof args.working_dir === 'string' && args.working_dir.trim()
        ? args.working_dir.trim()
        : undefined;
      const allowedTools = Array.isArray(args.allowed_tools)
        ? args.allowed_tools.filter((x): x is string => typeof x === 'string')
        : undefined;
      const maxBudgetUsd = typeof args.max_budget_usd === 'number' ? args.max_budget_usd : undefined;

      const row = startClaudeTask({
        task,
        working_dir: workingDir,
        allowed_tools: allowedTools,
        max_budget_usd: maxBudgetUsd,
        source_chat_msg_id: galtMessageId,
      });
      return {
        ok: true,
        async: true,
        task_id: row.id,
        status: row.status,
        next_step: 'A live task card now renders below your bubble. Your reply should be brief — confirm you delegated the work; the card streams progress and the final answer. Do not pretend to have results.',
      };
    },
  };
}

const claude_list_sessions: ToolDefinition = {
  name: 'claude_list_sessions',
  description:
    "List recent Claude Code sessions on this Mac. Returns the most recent sessions across every project Claude has touched, sorted by last-active. Useful for 'what was I working on in Claude yesterday', 'find that session where I was debugging X', 'show me my Claude history'. Each entry has a session_id, cwd, last_active timestamp, and a best-effort title from the first user message.",
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max sessions to return. Default 25, capped at 200.',
      },
      cwd_filter: {
        type: 'string',
        description: 'Optional absolute path to filter sessions to a specific cwd / project.',
      },
    },
    additionalProperties: false,
  },
  async execute(args) {
    const limit = Math.max(1, Math.min(200, typeof args.limit === 'number' ? args.limit : 25));
    const cwdFilter = typeof args.cwd_filter === 'string' && args.cwd_filter.trim()
      ? args.cwd_filter.trim()
      : undefined;
    const sessions = cwdFilter
      ? await claudeCli.listSessionsForCwd(cwdFilter, limit)
      : await claudeCli.listRecentSessions(limit);
    const running = claudeCli.listRunningSessions();
    const runningIds = new Set(running.map((r) => r.session_id));
    return {
      count: sessions.length,
      running_count: running.length,
      sessions: sessions.map((s) => ({
        session_id: s.session_id,
        cwd: s.cwd,
        last_active_at_ms: s.last_active_at,
        title: s.title,
        is_running: runningIds.has(s.session_id),
      })),
    };
  },
};

/* ============================================================
   Public registry
   ============================================================ */

/** Every tool Galt can call from the direct-chat surface, given the
 *  Galt-message id of the turn currently being generated. We pass the
 *  id in so any proposal tool can stamp it on the row for dedup +
 *  back-reference (which chat turn proposed this event). */
export function buildChatTools(galtMessageId: string): ToolDefinition[] {
  return [
    list_calendar_events,
    search_messages,
    list_recent_messages,
    list_auto_notes,
    get_contact,
    list_contact_notes,
    get_call_history,
    buildProposeCalendarEventTool(galtMessageId),
    request_user_approval,
    buildClaudeAskTool(galtMessageId),
    claude_list_sessions,
    list_gchat_spaces,
    list_gchat_messages,
    send_gchat_message,
    search_gchat_messages,
  ];
}

/** Legacy export for places that don't have a galt_message_id handy
 *  (e.g. introspection tools). The propose-* family is omitted here
 *  since those need a turn id. */
export const CHAT_TOOLS: ToolDefinition[] = [
  list_calendar_events,
  search_messages,
  list_recent_messages,
  list_auto_notes,
  get_contact,
  list_contact_notes,
  get_call_history,
  request_user_approval,
  claude_list_sessions,
  list_gchat_spaces,
  list_gchat_messages,
  send_gchat_message,
  search_gchat_messages,
];
