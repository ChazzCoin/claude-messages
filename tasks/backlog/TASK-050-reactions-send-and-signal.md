# TASK-050: Reactions / tapbacks — send + use as classifier signal

## User story

As a **user**, I want **Galt to react with a thumbs-up to trivial messages instead of generating a text reply**, and I want **incoming reactions to my replies to count as conversation closure**, so that **the system stays cheaper and less robotic, and stops piling up auto-notes after a conversation has clearly ended**.

## Why this matters

Two-sided value from one chat.db feature:
1. **Outbound:** "Got it" / "thanks!" / "ok" can be answered with a 👍 tapback for free, no token cost, looks more natural than a one-word text. Apple's AppleScript supports adding reactions to a target message.
2. **Inbound signal:** when a contact taps 👍 on our last sent message, it's a strong "closure" signal — Galt should suppress new auto-notes for that thread for some window. We already read tapbacks (`reactions[]` on each MessageRow) — just don't act on them yet.

## Scope

**In scope:**
- AppleScript send path that targets a `message.guid` with one of the 6 active reaction types (loved/liked/disliked/laughed/emphasized/questioned)
- New API endpoint: `POST /api/messages/:guid/react` body `{type: 'liked' | ... }`
- Galt reply mode: when classifier confidence on "trivial closure" is high AND user opt-in, send tapback instead of text draft
- Auto-note suppression: after we send a message, watch for incoming reactions targeting our message guid; if 👍 arrives within N hours, mark related auto-notes reviewed automatically

**Out of scope:**
- Removing/changing reactions (the table semantically supports this with negative type codes — defer)
- Custom emoji reactions (iOS 18+ feature, separate task)
- Reactions on group-chat messages from sub-participants (works the same but UI surface deferred)

## References

- chat.db tapback codes: `server/db/messages.ts` — `REACTION_NAME` and `REACTION_EMOJI` maps (2000–2005)
- Existing send wrapper: `server/send.ts`
- AppleScript reference for tapbacks: search `tell chat ... to send tapback` patterns; SQL-equivalent shape lives in `message.associated_message_type`
- Auto-note pipeline: `server/ai.ts::extractAutoNote` + `server/db/app.ts` auto_notes table

## Files expected to change

- `server/send.ts` — add `sendReaction(messageGuid, type)`
- `server/index.ts` — `POST /api/messages/:guid/react`
- `server/ai.ts` — classifier hook for "trivial closure → tapback" path
- `server/watcher.ts` (or wherever auto-notes fire) — suppression logic when incoming reaction targets our recent send
- `web/js/views/thread.js` — add a reaction picker on hover over the user's own bubbles (small toolbar)
- `data/app.db` — new `reaction_suppressions` table (chat_id, until_ts) — short-lived hint

## Acceptance criteria

- [ ] `curl -X POST /api/messages/<guid>/react -d '{"type":"liked"}'` adds a 👍 tapback in Messages.app
- [ ] Inspector on the target message shows the new reaction
- [ ] Incoming 👍 within 6h on a message we sent → existing unreviewed auto-notes for that thread auto-mark-reviewed
- [ ] AppleScript escaping is safe — fuzz with quote/newline/emoji-bearing guids (guid format is hex+hyphens, but defense-in-depth)

## Test plan (E2E)

1. Setup: pick a real test contact, send a known message from Galt
2. Steps: post the reaction via API, then via UI toolbar
3. Assertions: tapback appears in Messages.app within 5s; reading messages back via `/api/chats/<id>/messages` shows the reaction in `reactions[]`

## Manual verification

1. Open thread page, hover over your own bubble, click 👍 picker
2. Verify Messages.app on Mac shows the tapback applied
3. Have the test contact tapback your message → verify the auto-note for it auto-resolves

## Open questions / risks

- Is AppleScript reliable for all 6 tapback types? Some are documented as flaky pre-macOS 14.
- Suppression window — 6h arbitrary. Tune from real usage.
- Should the reaction picker be in the inspector instead of a hover toolbar? UX call.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- Manual verification clean
- `npm run typecheck` clean and `./bin/deploy` succeeds
- AUDIT.md entry on ship
