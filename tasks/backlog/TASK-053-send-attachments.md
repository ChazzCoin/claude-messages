# TASK-053: Send attachments (images, files)

## User story

As a **user**, I want **Galt to send images and files via iMessage**, so that **I can drop a screenshot, photo, or PDF into the compose bar and have it actually go**.

## Why this matters

Today our send path is text-only. Half the conversational signal in iMessage is image-bearing — replies that just need "here's the photo of the receipt", "here's a screenshot of the flight info", etc. Without attachment send, Galt's compose bar is a strict subset of Messages.app, and any AI-suggested workflow that wants to forward an image breaks.

AppleScript supports it:  `tell application "Messages" → send (POSIX file "/abs/path") to ...`

## Scope

**In scope:**
- `server/send.ts`: `sendAttachment(handleOrChatGuid, absPath)`
- API: `POST /api/chats/:id/send-attachment` (multipart/form-data) — backend stages the file under `data/outbound/<uuid>.<ext>` then sends
- Web: drag-drop on the compose bar + a paperclip button to pick from disk
- Limit checks: max size (Apple's iMessage cap is ~100MB; SMS is ~3MB; surface error before send)
- Cleanup: remove the staged file after `N` minutes once sent (don't pile up)

**Out of scope:**
- Sending a chat.db attachment we *received* back into another chat (forwarding) — separate task
- Multiple attachments in a single send — Apple supports it, but our API can be one-at-a-time for v1
- Inline images via clipboard paste — defer (drag-drop covers the main UX)

## References

- AppleScript send dictionary — `send (file ...)` form
- Existing `server/send.ts` for the chat-id resolution pattern
- Inspector already shows attachment metadata (filename, mime, size) — same shape applies to outbound

## Files expected to change

- `server/send.ts` — `sendAttachment()`
- `server/index.ts` — multipart handler (need to add `multer` or hand-roll)
- `web/js/views/thread.js` — drag-drop zone + paperclip button on compose
- `data/outbound/` — new staged-file directory (gitignored)

## Acceptance criteria

- [ ] Drag a PNG onto the compose bar → it sends → arrives in Messages on the recipient
- [ ] Paperclip button → file picker → same outcome
- [ ] PDF / docx / generic file works the same way
- [ ] Oversize file → clear error before AppleScript even fires
- [ ] Sent file is removed from `data/outbound/` after a grace window
- [ ] AppleScript path escaping is safe (paths with spaces, quotes)

## Test plan (E2E)

1. Setup: a test contact + a test image
2. Drag image into compose → assert it sends
3. Pick file via paperclip → same
4. Try a 200MB file → assert pre-send error

## Manual verification

1. Send a screenshot to the test contact via Galt
2. Verify it arrives as a real attachment (not as a link or text)
3. Send a small PDF, verify same

## Open questions / risks

- multipart parsing: we don't currently use any (everything's JSON). Pulling in `multer` is a small dep, hand-rolling is annoying. Pick.
- macOS Automation permission may re-prompt the first time we send a file (different AppleScript verb). Document.
- Group-chat sends — depends on TASK-052. Add the routing once that lands.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
