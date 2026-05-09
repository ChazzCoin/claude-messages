# TASK-056: Edit / unsend our own messages + treat incoming edits as classifier signal

## User story

As a **user**, I want **to edit or unsend a message Galt just sent on my behalf within Apple's 2-minute / 15-minute windows**, so that **mistakes don't sit forever in the recipient's thread**. And I want **incoming edits / unsends from contacts to bump the priority of their auto-note** so that **revisions get noticed (someone caring enough to fix wording usually means it matters more, not less)**.

## Why this matters

Two-sided value (mirrors TASK-050):
1. **Outbound:** Galt's auto-replies are higher-stakes than the user typing themselves — getting one wrong and being able to retract within 2 minutes is meaningful damage control. Apple supports edit (within 15min) and unsend (within 2min) on iMessage.
2. **Inbound signal:** when a contact edits a message, they cared enough to revise — that's a stronger signal than the original. Auto-note category should be re-evaluated; if a message was retracted entirely, any pending auto-note for it should be soft-deleted (the sender intended for it not to exist).

Inspector already surfaces both `date_edited` and `date_retracted` (DONE).

## Scope

**In scope:**
- `server/send.ts`: `editMessage(messageGuid, newBody)` and `unsendMessage(messageGuid)` AppleScript wrappers
- API: `POST /api/messages/:guid/edit` body `{body: "..."}` and `DELETE /api/messages/:guid`
- Web: edit/unsend buttons in the inspector for user's own messages within Apple's windows (compute remaining seconds; disable past expiry)
- Watcher: detect `date_edited` change on a previously-seen message → re-run auto-note extractor → update or replace existing note
- Watcher: detect `date_retracted` change → soft-delete the related auto-note (mark deleted_at, mirror delete to RTDB)

**Out of scope:**
- Editing/unsending sent SMS (Apple doesn't allow it)
- Editing on group chats — works the same per Apple, but verify in test

## References

- chat.db `date_edited` / `date_retracted` columns — `MessageRow` (server/db/messages.ts)
- Apple windows: 15min for edit, 2min for unsend (iOS 16+/macOS 13+)
- Inspector "Edit history" section already surfaces these
- Auto-note pipeline: `server/ai.ts::extractAutoNote`, `server/db/app.ts` auto_notes table, `server/firebase.ts::mirrorUpdateNote`/`mirrorDeleteNote`

## Files expected to change

- `server/send.ts` — `editMessage()`, `unsendMessage()`
- `server/index.ts` — `POST /api/messages/:guid/edit`, `DELETE /api/messages/:guid`
- `web/js/views/thread.js` — inspector edit/unsend buttons + countdown UI
- `server/watcher.ts` — detect edit/retract on seen messages
- `server/db/app.ts` auto_notes — `deleted_at` column (if not already present)

## Acceptance criteria

- [ ] Within 15min of Galt sending, inspector shows an "Edit" button; click → input new text → Messages.app updates → recipient sees edit
- [ ] Within 2min, inspector shows "Unsend" button; click → message disappears from both sides
- [ ] After windows expire, both buttons hide
- [ ] Incoming edit on a watched contact's message triggers auto-note re-extraction
- [ ] Incoming retract removes the related auto-note from /notes mirror

## Test plan (E2E)

1. Setup: send a Galt message
2. Within 2min, unsend → assert it's gone on recipient
3. Send another, wait >2min; verify unsend button gone, edit still available
4. Have a watched contact edit a recent message → assert auto-note updates

## Manual verification

1. Send via Galt, immediately edit through inspector, verify on iPhone
2. Send + unsend, verify gone on iPhone

## Open questions / risks

- AppleScript edit/unsend support is newer; may have macOS-version limits. Test on user's actual macOS.
- Retract handling for unsent messages we've already auto-noted: race condition between watcher seeing edit vs note creation. Idempotent path.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
