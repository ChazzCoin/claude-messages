# TASK-052: Send to a group chat by chat GUID

## User story

As a **user**, I want **Galt to send messages to group chats**, not just 1:1 conversations, so that **Away mode and Summon mode work in family/work groups, not just direct DMs**.

## Why this matters

Today the AppleScript send wrapper resolves to a single handle (`server/send.ts`). For groups, this is wrong — Apple identifies group chats by their `chat.guid` (e.g. `iMessage;+;chat123456`), not by any single member's handle. Result: any draft generated in a group chat fails to send or sends to the wrong target.

This is a hard prerequisite for Away/Summon to work outside 1:1.

## Scope

**In scope:**
- `server/send.ts`: `sendToChat(chatGuid, body)` AppleScript variant — `tell application "Messages" → send <text> to chat id <chatGuid>`
- Send-router decision: when given a `chat_id`, look up `chat.guid` in chat.db; if it's a group chat (multi-participant), use `sendToChat`; else use the existing handle path
- API: `POST /api/chats/:id/send` already takes chat_id — switch internal routing based on participant count
- Per-chat send-style detection (iMessage-only group? mixed-SMS? — surface error if SMS group, since AppleScript group SMS is unreliable)

**Out of scope:**
- Sending to NEW group chats (creating one) — separate task
- Renaming groups, changing photo, adding participants — out of scope

## References

- Existing single-recipient send: `server/send.ts::sendiMessage`
- Chat enumeration: `server/db/messages.ts::listChats`
- chat.db `chat` table — `chat_identifier`, `guid`, plus `chat_handle_join` for participant count
- CLAUDE.md "Pause points" notes group-chat sender resolution as an open question

## Files expected to change

- `server/db/messages.ts` — helper `getChatGuid(chatId)` and `isGroupChat(chatId)`
- `server/send.ts` — `sendToChat(chatGuid, body)` + routing
- `server/index.ts` — `POST /api/chats/:id/send` route uses the router
- Tests against a known group chat (manual)

## Acceptance criteria

- [ ] Sending via `POST /api/chats/<group-chat-id>/send` lands in the group, not in a DM
- [ ] Away/Summon mode operating on a group chat uses the group send path
- [ ] Sending to a 1:1 chat still works exactly as before
- [ ] Mixed-SMS-group attempts return a clear 400 error rather than silently failing
- [ ] AppleScript escaping for the chat GUID (which contains `+` and `;`) is correct

## Test plan (E2E)

1. Setup: a test group with at least 2 other participants
2. Send a message via the API
3. Assert: message appears in the group on all participants' devices
4. Negative: pick a known SMS-only "group" → expect 400

## Manual verification

1. Pick a real iMessage group on the user's Mac
2. Use Galt to send a message
3. Verify it shows up in the group on iPhone, not as a separate DM thread

## Open questions / risks

- Some groups Apple represents as `iMessage;+;chat<id>`, others have a numeric ID prefix. Document the actual format the user's Mac uses.
- Mixed iMessage+SMS groups: do we route to anyone? Probably error out.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
