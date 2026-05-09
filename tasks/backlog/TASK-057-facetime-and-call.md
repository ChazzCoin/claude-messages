# TASK-057: Initiate FaceTime / phone call from the dashboard

## User story

As a **user**, I want **a button next to a contact's name to start a FaceTime or phone call**, so that **when an auto-note says "Mom called twice — call back" I can do it from the same surface I'm reviewing in**.

## Why this matters

The whole dashboard is "everything about your messages in one place" but right now if I want to call back I leave Galt and pick up the phone. URL-scheme handlers (`facetime://+15551234567`, `tel:+15551234567`, `facetime-audio://...`) work on macOS without any AppleScript or native API — just `open` the URL.

Tiny task; high quality-of-life return.

## Scope

**In scope:**
- Three buttons (FaceTime video, FaceTime audio, phone) added to the thread workbench Identity card and to the contact rows in inbox/radar
- Backend: trivial `POST /api/contacts/call` endpoint that shells `open <scheme>:<handle>` (or just renders `<a href="...">` from the frontend — even simpler)
- Honor the contact's actual phone vs email handle (FaceTime works on both; tel: only on phone)
- Surface unavailable buttons greyed out (e.g. tel: when the handle is an email)

**Out of scope:**
- Recording call history from these clicks (Apple's CallHistory.storedata captures it natively — see TASK-063)
- In-call UI — Apple owns that

## References

- macOS URL schemes: `facetime`, `facetime-audio`, `tel`, `sms` (the last is interesting for SMS-only fallback)
- Identity workbench card: `web/js/views/thread.js::renderIdentityCard`
- Contact row pattern in inbox/radar views

## Files expected to change

- `web/js/views/thread.js` — add call buttons to Identity card
- `web/js/views/inbox.js`, `web/js/views/radar.js` — add to row templates
- `web/css/main.css` — small icon-button row style
- Optional `server/index.ts` if we want the route; otherwise pure frontend

## Acceptance criteria

- [ ] Click "FaceTime" on a contact with a phone handle → FaceTime app opens with the call setup
- [ ] Click "Call" → Phone app on Mac (or Continuity to iPhone) places the call
- [ ] Email-only handles: FaceTime works, phone is greyed out with tooltip
- [ ] Group chats: buttons hidden (not meaningful)

## Test plan (E2E)

1. Setup: a 1:1 contact with a phone handle
2. Click each button in turn
3. Assert the appropriate Apple app opens

## Manual verification

1. Open a 1:1 thread
2. Click FaceTime, video → confirm FaceTime app launches
3. Click Phone → confirm Continuity dial pad

## Open questions / risks

- Continuity calling depends on the iPhone being on the same network/iCloud — system requirement, document.
- macOS may prompt for permission first time we open `tel:` from a non-Safari context.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
