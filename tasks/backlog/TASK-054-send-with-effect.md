# TASK-054: Send with iMessage effect (fireworks, balloons, etc.)

## User story

As a **user**, I want **to send a message with an Apple effect** (slam, loud, gentle, invisible ink, fireworks, lasers, confetti, etc.), so that **Galt can match the recipient's expressive vibe and add a celebratory flourish where appropriate** (a "happy birthday!" with confetti hits different from plain text).

## Why this matters

Mostly novelty value, but it's part of "Galt should feel like the user wrote it" — the user uses effects sometimes, so the system that's standing in for them should be able to. Also, several auto-suggest opportunities: "happy birthday" → confetti; "congrats!" → fireworks; "I love you" → heart screen. Low-effort once the wrapper is in.

## Scope

**In scope:**
- `server/send.ts`: `sendiMessage(handle, body, { effect?: ExpressiveStyle })`  
  effect maps to AppleScript: `send <text> with effect <name>` or via the appropriate `expressive_send_style_id` value
- API: `POST /api/chats/:id/send` accepts optional `effect` parameter
- Compose bar: small dropdown next to the send button with the 5 bubble effects (slam/loud/gentle/invisibleink/echo) and optional screen effects
- Inspector already labels `expressive_send_style_id` (DONE)

**Out of scope:**
- AI auto-suggesting an effect based on content classification — separate task once basic send works
- Receiving / rendering inbound effects on bubbles (Apple's UI shows them; we don't, but inspector now exposes them)

## References

- `EXPRESSIVE_LABELS` map in `web/js/views/thread.js` — full list of bundle ids
- AppleScript Messages dictionary — `send ... with effect`
- Apple's expressive bundle IDs: `com.apple.MobileSMS.expressivesend.<name>` for bubble effects, `com.apple.messages.effect.CK<Name>Effect` for screen effects

## Files expected to change

- `server/send.ts` — extend send signature with `effect`
- `server/index.ts` — accept `effect` on send
- `web/js/views/thread.js` — effect picker dropdown on compose
- `web/css/main.css` — picker style

## Acceptance criteria

- [ ] `POST /api/chats/<id>/send` with `{body: "...", effect: "fireworks"}` sends with the fireworks screen effect
- [ ] Each of the 5 bubble effects works (gentle, slam, loud, invisibleink, echo)
- [ ] Each documented screen effect works (confetti, fireworks, lasers, hearts, balloons-equivalent if Apple still supports it)
- [ ] Recipient sees the effect on iOS
- [ ] Plain send (no effect) still works exactly as today

## Test plan (E2E)

1. Setup: test contact
2. Send each effect in turn via the API
3. Have user check iPhone to confirm each rendered correctly

## Manual verification

1. Open compose, pick "fireworks", send "Happy birthday!"
2. Verify recipient's iOS device renders the screen effect

## Open questions / risks

- Some effects are macOS-version sensitive (newer screen effects may not be in old Messages app dictionaries). Test on the actual user's macOS.
- Picker UI in compose bar — small dropdown vs popover? Pick on impl.

## Blocker notes

(empty)

---

**Definition of done:**
- All acceptance criteria checked
- AUDIT.md entry on ship
