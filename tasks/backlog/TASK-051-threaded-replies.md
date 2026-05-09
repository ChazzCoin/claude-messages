# TASK-051: Threaded replies — render incoming, send outgoing

## User story

As a **user reading a group chat in Galt**, I want **inline replies to render attached to the message they're replying to**, and as a **user sending into a group**, I want **Galt to be able to reply-to a specific message** so that **multi-topic group chats are followable and Galt's replies don't get lost in a busy thread**.

## Why this matters

Apple's "inline reply" feature is the only way to keep multi-topic group chats coherent (think family group chat with simultaneous logistics + birthday talk + meme threads). We currently flatten everything into a linear feed, which is unreadable in active groups, and our outgoing sends drop into the bottom without visual link to what they're answering.

The chat.db data is already there — `thread_originator_guid` + `thread_originator_part` — and the inspector now reads them. This task is rendering + send.

## Scope

**In scope:**
- Bubble renderer reads `thread_originator_guid` and renders an "↳ in reply to:" preview pill above the bubble linking to the originator (click → scrolls + highlights)
- AppleScript send wrapper: `sendThreadedReply(chatGuid, body, targetMessageGuid)` — forms the right `tell ... to send ... reply to ...` syntax
- Compose bar: reply-to mode (click the inspector's new "Reply to this" button → compose pre-loads with target)
- API: `POST /api/chats/:id/send` accepts optional `reply_to_guid`

**Out of scope:**
- Native UI for "click bubble → reply" gesture (use inspector button as the entry point for v1)
- Replying-to-a-specific-part of a multi-part message (`thread_originator_part > 0`) — defer

## References

- chat.db columns now in `MessageRow`: `thread_originator_guid`, `thread_originator_part` — server/db/messages.ts
- Inspector Section "Threaded reply" (server/db/messages.ts → web/js/views/thread.js)
- AppleScript `reply to` syntax (Messages dictionary)

## Files expected to change

- `web/js/views/thread.js` — render reply preview pill above bubbles
- `web/css/main.css` — `.bubble-reply-preview` pill style
- `server/send.ts` — `sendThreadedReply()`
- `server/index.ts` — extend `POST /api/chats/:id/send` with `reply_to_guid`
- `web/js/views/thread.js` (compose) — reply-to mode in the compose bar

## Acceptance criteria

- [ ] Group-chat threads with inline replies render bubbles with their reply-target preview
- [ ] Click the preview → page scrolls to + briefly highlights the originator bubble
- [ ] Compose-with-reply works end-to-end: target shows in Messages.app as a proper inline reply (not just a bare-text reply)
- [ ] Receiver-side test: sending Galt's reply with `reply_to_guid` shows up correctly in iMessage on the test contact's device
- [ ] Inspector on a threaded message already shows GUID + part (DONE — verify still works)

## Test plan (E2E)

1. Setup: a test group with at least 3 messages, the user replies inline to one
2. Reload thread → assert preview pill is visible on the reply bubble
3. Click preview → assert scroll + highlight
4. From compose, click "reply to" on the inspector → send → verify reply appears as inline reply on iOS

## Manual verification

1. Open a real group chat in Galt
2. Inline replies should be visually distinct
3. Send a threaded reply via Galt; check iPhone shows it correctly threaded

## Open questions / risks

- Does AppleScript reliably build the threaded-reply send across macOS versions? Verify on the user's actual Mac.
- Group-chat send to the right `chat_identifier` depends on TASK-052 — order these together.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
