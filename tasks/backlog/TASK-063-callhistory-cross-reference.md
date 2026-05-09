# TASK-063: CallHistory cross-reference for context enrichment

## User story

As a **user**, I want **Galt to know how recently and how often a contact has called me**, so that **drafts and auto-notes carry context like "Mom called twice today, no callback yet" instead of treating every text as if no other communication existed**.

## Why this matters

Personal communication is multi-channel. "Did you see my call?" "Call me back when you can" — the meaning depends on whether there's a recent missed/answered/declined call between us. Today Galt has zero call awareness. Adding it is a one-time `sqlite3` reader against `~/Library/Application Support/CallHistoryDB/CallHistory.storedata` (Core Data SQLite store; same FDA grant covers it).

Massive context-quality jump for the cost of one new reader.

## Scope

**In scope:**
- New reader: `server/db/calls.ts` — read-only `Database()` against CallHistory.storedata
- Schema mapping (Core Data adds Z-prefixed columns):
  - `ZCALLRECORD` table: `ZADDRESS` (handle, normalized), `ZDATE` (Apple-epoch), `ZDURATION`, `ZANSWERED`, `ZORIGINATED` (1=outbound, 0=inbound), `ZSERVICE_PROVIDER` (FaceTime / phone), `ZNAME`
- Helper: `getCallHistoryForHandle(handle, sinceMs?)` returns `[{ts_ms, direction, answered, duration_s, service}]`
- Pipeline integration: when extracting an auto-note or drafting a reply for a contact, prepend a 1-line context blurb if there's call activity in the last 7 days
- Inspector / Workbench: identity card grows a "Recent calls" mini-pill showing most recent activity ("📞 missed 2h ago", "📹 FaceTime 3d ago")
- Optional: a new `/api/contacts/:handle/calls` endpoint for the radar/profile views to consume

**Out of scope:**
- Initiating calls (TASK-057 handles that)
- Voicemail transcription (separate Apple data source)
- Group FaceTime call participants (column exists but seldom needed for personal AI)

## References

- CallHistory store path: `~/Library/Application Support/CallHistoryDB/CallHistory.storedata` (SQLite, Core Data)
- Apple's Core Data "Z" prefix convention; ZUUID, ZDATE, etc.
- Apple-epoch conversion: `appleDateToUnixMs()` in `server/db/messages.ts` (reuse)
- Handle normalization: `normalizeHandle()` in `server/db/contacts.ts` — `ZADDRESS` is already roughly E.164 but may need normalization
- Auto-note prompt assembly: `server/ai.ts::AUTO_NOTE_SYSTEM` and the user-content build site
- Draft pipeline: `server/ai.ts::draftReply` user-content build site

## Files expected to change

- `server/db/calls.ts` — new file, reader
- `server/index.ts` — `/api/contacts/:handle/calls` if needed
- `server/ai.ts` — auto-note + draft user-content prepends "Recent call context" line when present
- `web/js/views/thread.js` — Identity card pill row for recent calls

## Acceptance criteria

- [ ] Backend can list recent calls for a handle (manual curl)
- [ ] Auto-note for a watched contact includes call context when calls exist within 7d
- [ ] Drafts to a contact who called recently reference the call appropriately ("you called earlier", "sorry I missed your call")
- [ ] Identity workbench card shows most recent call as a pill (when within 30d)
- [ ] No additional creds / permissions needed beyond existing FDA

## Test plan (E2E)

1. Setup: a test contact who's both texted and called you today
2. Open thread → identity card shows the call pill
3. Trigger an auto-note (have them text you something substantive) → note context references the recent call

## Manual verification

1. Pick a contact you talked to recently
2. Open their thread, verify call pill shows correctly
3. Have them text you, verify auto-note picks up call context

## Open questions / risks

- CallHistory.storedata schema is Core Data — column names may shift across macOS versions. Defensive PRAGMA table_info checks at boot.
- Privacy: call metadata stays local (we don't mirror it to RTDB). Document.
- Address normalization: ZADDRESS sometimes has "+1" prefix, sometimes not. Match through `normalizeHandle()`.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
