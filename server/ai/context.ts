// Per-turn context: the data inputs every mode might fold into a system
// prompt, plus the formatted thread that always goes in the user role.
//
// Modes consume from a Context — they don't re-fetch. The handler builds
// one Context per inbound message (one-shot data load) and hands it to
// whichever mode is firing.
//
// Each section formatter returns ready-to-include text or `null` when
// the underlying data is empty. Modes choose which sections to include
// and in what order. The Context class doesn't impose any ordering — it
// just produces consistent paste-ready text per section.
//
// IMPORTANT: formatThread() owns the user-role payload. The framework
// (PromptMode.draft) puts its output in the user role unconditionally,
// guaranteeing that the most recent message is the LAST thing the model
// reads. Sections produced here go in the system role only.

import type { ThreadTurn } from '../ai.js';

export interface ContextInput {
  /** chat.db chat.ROWID — used by callers for routing decisions, not
   *  the prompt itself. */
  chatId: number;
  /** True for group chats. Some modes adjust per-turn framing. */
  isGroup: boolean;

  /** Display names used inside prompts. */
  recipientName: string;
  userName: string;

  /** Recent conversation messages, oldest → newest. The very last
   *  element is the most recent message — formatThread() preserves
   *  that ordering exactly. */
  thread: ThreadTurn[];

  /** Galt's voice profile prose (settings.galt_voice_profile). */
  voiceProfile: string;

  /** Per-contact long-form profile (user's own description of who
   *  this contact is). Empty string when not set. */
  contactProfile: string;

  /** Per-contact note bullets — short atomic facts. Empty when none. */
  contactNotes: string[];

  /** macOS Contacts.app block (role / birthday / freeform notes the
   *  user wrote in Contacts). */
  addressBookContext: string;

  /** macOS Calendar availability summary, pre-formatted. */
  userAvailability: string;
}

export class Context {
  constructor(public readonly input: ContextInput) {}

  /* ── per-section formatters ──────────────────────────────────── */

  /** Galt's voice profile, wrapped in a labeled block. */
  voiceSection(): string | null {
    const body = this.input.voiceProfile.trim();
    if (!body) return null;
    return `\nGALT'S VOICE — how Galt sounds when speaking. Apply throughout. This is the baseline tone; the immediate thread can adjust register (more casual with friends, more measured in serious moments) but the voice underneath stays Galt:\n"""\n${body}\n"""`;
  }

  /** User-written long-form prose about THIS contact. Higher priority
   *  than generic voice defaults — modes typically include this when
   *  set. */
  contactProfileSection(): string | null {
    const body = this.input.contactProfile.trim();
    if (!body) return null;
    return `\nWHO YOU'RE TALKING TO — the user's own description of this contact: relationship, identity, sensitivities, and how they want you to interact with this person. This OVERRIDES generic defaults — match the tone and posture this profile implies, even when the voice profile would suggest otherwise:\n"""\n${body}\n"""`;
  }

  /** Per-contact note bullets. Most recent at the bottom (the model
   *  treats later items as more current). */
  contactNotesSection(): string | null {
    const items = this.input.contactNotes
      .map((n) => n.trim())
      .filter((n) => n.length > 0);
    if (items.length === 0) return null;
    const list = items.map((n) => `- ${n}`).join('\n');
    return `\nNOTES ABOUT THIS CONTACT (recent atomic facts — apply when drafting; the most recent notes near the bottom are most current):\n${list}`;
  }

  /** macOS AddressBook record. Latent context for situational
   *  awareness — modes typically tell the model NOT to recite these
   *  facts back. */
  addressBookSection(): string | null {
    const body = this.input.addressBookContext.trim();
    if (!body) return null;
    return `\nADDRESS BOOK CONTEXT — what the user has saved about this contact in macOS Contacts.app (role, birthday, free-form notes). This is latent context the user already wrote down. Use it to ground the reply, but don't volunteer these facts unprompted — they're for YOUR situational awareness, not facts to recite back:\n"""\n${body}\n"""`;
  }

  /** Calendar availability — opt-in for scheduling-relevant threads
   *  only. Modes typically include this with strict guardrails ("use
   *  ONLY when the thread asks about availability"). */
  calendarSection(): string | null {
    const body = this.input.userAvailability.trim();
    if (!body) return null;
    return `\nUSER'S CALENDAR (from macOS Calendar.app — aggregates iCloud, Google, Exchange). Use ONLY when the thread asks about the user's availability or schedule (e.g. "are you free Thursday", "what time works"). Do NOT volunteer calendar contents; do NOT invent events not listed here. If the thread doesn't ask about scheduling, ignore this block:\n"""\n${body}\n"""`;
  }

  /* ── thread formatter (universal — the framework owns the user role) ── */

  /** Format the thread for the user role of the chat completion.
   *  Oldest first, newest LAST. By framework convention this string
   *  is the entire user-role payload — the newest message is the
   *  very last line; OpenAI generates after that line.
   *
   *  Speaker prefix:
   *    me                  - user-typed (from chat.db is_from_me=1)
   *    them                - 1:1 incoming
   *    them (Mom)          - group chat incoming with attribution
   *
   *  Lines that look like `me: Galt: ...` are Galt's previous turns
   *  in this thread (the "Galt: " prefix is added at send-time by
   *  withGaltPrefix, then echoes back through chat.db with
   *  is_from_me=1). The model treats them as its own previous output. */
  formatThread(): string {
    const lines = this.input.thread.map((m) => {
      const speaker = m.author === 'me'
        ? 'me'
        : m.attribution
          ? `them (${m.attribution})`
          : 'them';
      return `${speaker}: ${m.text}`;
    });
    return `Thread (oldest → newest):\n${lines.join('\n')}`;
  }

  /* ── convenience accessors ───────────────────────────────────── */

  get recipientName(): string { return this.input.recipientName; }
  get userName(): string      { return this.input.userName; }
  get isGroup(): boolean      { return this.input.isGroup; }
  get chatId(): number        { return this.input.chatId; }
}
