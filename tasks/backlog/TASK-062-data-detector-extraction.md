# TASK-062: Apple Data Detector parser (payload_data → entities)

## User story

As a **user**, I want **dates, addresses, phone numbers, flight numbers, and package tracking codes that Apple's Data Detectors already extracted to be available to Galt for free**, so that **the calendar-extraction LLM call can be replaced (or augmented) by free, more-accurate native data, and so that auto-notes carry structured entity data without a model call**.

## Why this matters

Apple runs its own NLP on every inbound message and stores the results in `message.payload_data` (binary blob; presence indicated by `has_dd_results=1`). It's already there, free, and more accurate than re-extracting via LLM (it's the same engine that powers Apple's clickable links in Messages, Mail, Notes, etc.).

Today we re-extract dates via `extractCalendarEvent` (LLM call, costs money, sometimes wrong). Native extraction would replace that for the easy cases and only fall back to LLM for ambiguous ones.

Inspector already exposes `has_dd_results` (DONE) — task is the parser.

## Scope

**In scope:**
- Parser for `payload_data` blob — it's a binary `NSKeyedArchiver` plist (Apple typedstream-adjacent)
- Returns a structured `DataDetectorResult`:
  - `dates`: [{start_iso, end_iso, raw_text}]
  - `addresses`: [{full_text, lat?, lon?}]
  - `phone_numbers`: [{e164, raw_text}]
  - `flight_numbers`: [{carrier, number, raw_text}]
  - `tracking_numbers`: [{carrier, number, raw_text}]
  - `urls`: [{url, raw_text}]
- Pipeline change: when `has_dd_results=1`, parse first; only fall through to `extractCalendarEvent` LLM if dates list is empty (or to validate ambiguous cases)
- Inspector "Data Detectors" section: replace the bool with an itemized list of what Apple found
- Cost savings tracked: log "would have called LLM, used DD instead" → counts in AI usage panel as savings

**Out of scope:**
- Decoding ALL payload_data — there's other data in there (link previews, etc.); just data-detector results
- Writing back to chat.db (read-only access — never)

## References

- Apple's `NSKeyedArchiver` plist format — third-party Node libs exist (`bplist-parser`, `simple-plist`)
- Some prior art: imessage-exporter (Rust) decodes payload_data; can crib structure
- Existing `attributedbody.ts` is a similar shape — naive typedstream parser
- Calendar pipeline: `server/ai.ts::extractCalendarEvent` is the replacement target

## Files expected to change

- `server/data_detectors.ts` — new file, payload_data parser
- `server/db/messages.ts` — add `data_detectors?: DataDetectorResult` to `MessageRow`, populate in `toMessageRow` from raw `payload_data` buffer
- `server/db/messages.ts` SQL — add `m.payload_data AS payload_data` to the column block (already structured for easy add)
- `server/ai.ts` — calendar pipeline checks DD first
- `web/js/views/thread.js` — inspector "Data Detectors" section becomes itemized

## Acceptance criteria

- [ ] Inbound message with a date phrase (e.g. "Saturday at 3pm") → DD parser returns the resolved ISO date
- [ ] Inspector "Data Detectors" section lists what Apple found, structured
- [ ] Calendar extraction pipeline uses DD result and skips LLM call when DD is sufficient
- [ ] When DD is empty / ambiguous, LLM still fires — no regressions
- [ ] AI usage panel shows reduced calendar-extraction calls in days following deploy

## Test plan (E2E)

1. Setup: send self a message containing "lunch tomorrow at 1pm at Joe's Deli, 123 Main St"
2. Assert: DD result has 1 date (resolved) + 1 address + 0 phone numbers
3. Assert: calendar proposal created via DD path, no LLM call counted
4. Send "let me know about the meeting" (vague) → assert LLM fallback fires

## Manual verification

1. Inspector on a real message with dates/addresses: section should be detailed
2. Watch AI usage panel before vs after a few inbound messages with embedded dates — see fewer LLM calendar calls

## Open questions / risks

- payload_data format may differ across iOS versions — keep parser defensive, fall back to LLM if parse fails
- imessage-exporter's Rust decoder is the most thorough public reference; if rolling our own gets too gnarly, shelling out to that binary is a defensible alternative
- This is the largest infra task in the bunch — payload_data is opaque-binary. Budget multiple sessions.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
