# TASK-XXX: <short title>

> Copy this file to `tasks/backlog/TASK-XXX-slug.md`, fill in every
> section, then move to `tasks/active/` when work begins.
>
> Before starting: read `CLAUDE.md` and `.claude/task-rules.md`.

## User story

As a **<role>**, I want **<capability>** so that **<outcome>**.

## Why this matters

One or two sentences. What breaks today without this? What does the
iOS app do that the web app doesn't? Link the relevant CLAUDE.md
section if applicable.

## Scope

**In scope:**
-

**Out of scope (explicit):**
-

## References

- iOS source: `<file or class name>` — relevant fields/behavior
- Web model: `src/models/<File>.js`
- Existing pattern to follow: `<component or hook>`
- Related CLAUDE.md section: `<heading>`

## Files expected to change

List every file you expect to create or modify. The agent must not
touch files outside this list without updating the task first.

- `src/...`
- `src/...`
- `e2e/tests/<task-slug>.spec.js` (new)

## Acceptance criteria

Specific, verifiable. Each item must be checkable by either an E2E
test, a build/lint command, or a one-line manual verification.

- [ ]
- [ ]
- [ ]

## Test plan (E2E)

Write this **before** implementation. The test is a contract, not a
rationalization of whatever the code ended up doing.

1. Setup: <seeded state, signed-in user>
2. Steps:
   1.
   2.
3. Assertions:
   -

## Manual verification (in addition to E2E)

Steps the human reviewer will run locally:

1.
2.

## Open questions / risks

- 

## Blocker notes

(Agent fills this in if it gets stuck. Leave empty when creating.)

---

**Definition of done:**
- All acceptance criteria checked
- E2E test passes (or N/A documented)
- The project's build command clean (per `CLAUDE.md` / `/build`)
- PR opened, linked from this file, ready for human review
