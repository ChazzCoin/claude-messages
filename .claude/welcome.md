# 👋 Welcome back

> First file Claude reads on session start. Auto-updated by
> `/handoff`. Edit by hand anytime if the auto-write got it wrong.

---

## Where I left off

Testing COSS/COA wiring end-to-end. Pulled origin/main to **5683ef6** (wire send output to COA task view) and deployed the backend. Local codebase is now current, but the **LaunchAgent is still on 8767ba4** (pre-global_claude_task). **Run `./bin/deploy` first thing** before testing anything.

## Heads up

- **Option A is done:** Send-from-COSS → COA task stream pops open. Works but feels like a parade of tasks.
- **Option B is next:** Render response stream *inside* COSS scoped to the active pill. Don't start until Option A is verified end-to-end against deployed backend.
- **One dead command:** `set_voice_profile` in the command listener — marked HIGH in the audit but deferred.

## What to read first

- `docs/audits/2026-05-13-cos-coss-wiring.md` — full architecture, data paths, the three HIGH findings
- `docs/handoff/2026-05-13.md` — deep context (what surprised you, warnings for next time)

## Active branch

- HEAD (detached) — **5683ef6** *(working tree: clean)*

---

*Updated by `/handoff` (or by hand) at end of session. Stays small —
under ~20 lines. Deep context lives in `docs/handoff/<date>.md`.*
