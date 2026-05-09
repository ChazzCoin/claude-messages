# TASK-055: Mark a thread as read after Galt auto-replies

## User story

As a **user**, I want **Messages.app on my Mac and iPhone to show clean (no badge) after Galt has auto-replied to a thread**, so that **the unread badge actually means "needs me" and not "Galt already handled it".**

## Why this matters

When Away mode or Summon fires and Galt replies, Apple's read state for that thread stays "unread" — because *I* didn't open the thread on my devices, the auto-reply was sent via AppleScript without marking-read. Result: my Messages.app badges keep ticking up even though everything's handled. The whole point of Away mode is "I don't need to look at Messages right now" — the badge reading 47 unread defeats that.

AppleScript can mark a chat as read, or we can update `chat.db.message.is_read` directly (no — read-only access; AppleScript is the right path).

## Scope

**In scope:**
- `server/send.ts`: `markChatRead(chatGuid)` — AppleScript variant
- Plumbing: every Galt-originated send (Away auto-reply, Summon reply, manual approve-and-send) calls `markChatRead` afterward, fire-and-forget
- Settings toggle: "Mark threads read after Galt replies" — default ON; users who want the badge as a record-of-AI-activity can opt out

**Out of scope:**
- Marking a single message read (Apple API is chat-level, not message-level)
- Bulk "mark all read" UI button on the dashboard — separate small task

## References

- AppleScript `read status` on `chat` — Messages.app dictionary
- Existing post-send hooks in `server/send.ts` and the Away path

## Files expected to change

- `server/send.ts` — `markChatRead()`
- `server/index.ts` — call after every internal-send (Away, Summon, approve-draft)
- `server/db/app.ts` settings — new `mark_read_after_galt_reply` (default 1)
- Optional: settings UI in the dashboard

## Acceptance criteria

- [ ] After Galt sends an Away auto-reply, the thread shows as read in Messages.app on Mac (no orange dot)
- [ ] On iPhone, badge count goes down within Apple's sync window
- [ ] Setting OFF disables the behavior
- [ ] AppleScript escaping for chat GUID is correct

## Test plan (E2E)

1. Setup: Away mode on, watched contact
2. Have contact send → Galt auto-replies → assert thread shows read on Mac
3. Toggle setting off, repeat, assert thread stays unread

## Manual verification

1. Trigger an Away reply
2. Check Mac Messages.app: thread should not have unread indicator
3. Check iPhone: badge count reflects only threads that actually need attention

## Open questions / risks

- Apple's read-state propagation across devices is async (depends on iCloud Messages). Don't promise instant on iPhone.
- Marking a chat read removes the typing indicator visibility for the user — usually fine but document.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
