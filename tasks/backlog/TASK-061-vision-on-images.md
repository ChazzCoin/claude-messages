# TASK-061: GPT-4V image understanding for inbound images

## User story

As a **user**, I want **image attachments (photos, screenshots) to be described and included in auto-notes and drafts**, so that **"Mom sent a photo of the new puppy" becomes a real note** instead of a silent attachment, and so that **screenshots of flight confirmations, receipts, and addresses become extractable context**.

## Why this matters

Massive blind spot today. Half of meaningful inbound to most users is image-bearing — screenshots of plans, receipts, photos. Without vision, the auto-note pipeline sees only the text part (often empty or "[photo]") and skips. With it: every image becomes a structured signal.

## Scope

**In scope:**
- Detect inbound image attachments (mime starts with `image/`)
- Send to OpenAI Chat Completions with the image URL/data + a short structured prompt:
  - **Caption** — 1 sentence describing what's depicted
  - **Type** — photo / screenshot / meme / document / receipt / other
  - **Extracted text** — OCR (only when type=screenshot/document/receipt/meme; skip for photos)
  - **Notable entities** — dates / addresses / phone numbers / flight numbers / URLs visible
- Cache on new `image_descriptions` table keyed by `attachment.guid`
- Auto-note pipeline: when a message is image-only, use the caption + extracted text as the message body
- Inspector "Attachments" section shows the AI description below each image
- Bubble: small caption appears under inline images (toggleable in settings)

**Out of scope:**
- Generating images to send (text-to-image)
- Video understanding (separate; OpenAI's video support is newer)
- Live camera scenes

## References

- OpenAI vision: `chat.completions.create({model: 'gpt-4o', messages: [{role: 'user', content: [{type: 'image_url', ...}]}]})`
- Existing attachment handling in `server/db/messages.ts` (loaded into `MessageRow.attachments[]`)
- Inspector "Attachments" section already shows mime + size

## Files expected to change

- `server/ai.ts` — `describeImage(filePath)` + `recordAiUsage` with `image_describe` purpose
- `server/db/app.ts` — new `image_descriptions` table (attachment_guid PK, caption, type, ocr_text, entities_json, described_at)
- `server/watcher.ts` (or auto-note path) — branch when message has image attachments
- `web/js/views/thread.js` — caption rendering under inline images + inspector enrichment

## Acceptance criteria

- [ ] Inbound image gets described within 30s of arrival
- [ ] Caption shows under the image bubble (toggleable)
- [ ] Inspector "Attachments" section shows full description + type + entities + OCR
- [ ] Auto-note for image-only message uses the caption as basis (not "[image]")
- [ ] Re-loading doesn't re-describe (cache hit)
- [ ] Costs roll up into AI usage panel

## Test plan (E2E)

1. Setup: have test contact send a photo of an outdoor scene + a screenshot of a flight confirmation
2. Assert: photo gets a "photo of X outdoors" caption with no OCR
3. Assert: screenshot gets caption + OCR text + extracted flight entities

## Manual verification

1. Send a screenshot of a confirmation email to Galt
2. Verify auto-note picks up the actual confirmation details
3. Reply via Galt → drafted reply should reference what was in the image

## Open questions / risks

- gpt-4o on images is ~30x more expensive than gpt-4o-mini text; rate limits and budget caps matter. Default policy: only describe images from watched contacts? Or all? User decides.
- Privacy: images go to OpenAI. Same opt-in/opt-out conversation as Whisper.
- HEIC images: need confirmation OpenAI accepts them, otherwise convert.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
