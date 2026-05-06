---
name: audit
description: Audit a section of the codebase and produce a two-part report — (1) architectural breakdown with code snippets and (2) honest pros/cons assessment. The report is rendered in chat AND saved to `docs/audits/<YYYY-MM-DD>-<target-slug>.md` so audits accumulate as durable project history future sessions can reference. Triggered when the user wants a code review on a slice of the repo — e.g. "/audit src/firebase", "audit the inspection detail flow", "audit what we have for work orders", "give me a read on the auth code".
---

# /audit — Codebase audit

Take a target (a directory, a feature, a module, a file) and produce
a single readable report with two parts: how it's built, and how it
holds up. No marketing voice. No soft-pedaling. Per CLAUDE.md: blunt
resonant honesty, calibrated confidence, no narratives.

The report is rendered in chat **and** persisted to disk under
`docs/audits/`. Past audits are durable context — future Claude
sessions can read them directly when they need the historical read
on a slice without re-doing the work.

## Behavior contract

- **Resolve the target.** If the user gives a vague target ("audit the
  inspection stuff"), do a quick `Glob`/`Grep` pass to enumerate
  candidate files, then state in one sentence what you're auditing
  before diving in. If the scope is genuinely ambiguous, ask once.
- **Read before opining.** Read every file in scope before writing
  Part 2. Don't assess from filenames. If the audit target is large
  (>~15 files or >~2k lines), spawn an `Explore` agent to map it,
  then read the highest-leverage files yourself.
- **Honest confidence.** If a concern is a guess, say "I think" or
  "likely". If it's verified by reading the code, state it flat. Don't
  pad uncertain claims with hedging adverbs to feel safer.
- **Persist the report.** Write the same report rendered in chat to
  `docs/audits/<YYYY-MM-DD>-<target-slug>.md` (create `docs/audits/`
  if missing). Slug from the audit target — `src-firebase`,
  `auth-flow`, `work-orders`. If a same-day audit on the same
  target already exists, suffix with `-2`, `-3`. Add a one-line
  frontmatter block at the top of the saved file: `**Target.** …
  **Scope.** … **Date.** YYYY-MM-DD`. The chat response is the
  same content; the disk file is the durable record.
- **No fix work.** This skill produces a report only. Do not edit
  code, do not file tasks, do not propose patches. If the user wants
  follow-ups, they'll route them through `/task` after reading.
- **Code snippets are evidence, not decoration.** Include a snippet
  only when it makes a point — a key abstraction, a smell, a
  surprising contract. Cite `file_path:line_number` so it's clickable.
- **Stay in scope.** If something out-of-scope catches your eye,
  mention it in a one-line "Adjacent observations" footer at most.
  Don't expand the audit unilaterally.

## Output structure

**Catalogue entry.** §6 Severity audit (primary, for the Findings
section) + markdown prose for Part 1 architectural breakdown,
"What's working" praise, Tradeoffs, and Bottom line. Code snippets
in Part 1 are normal ```<lang>``` fenced blocks.

**Note on structure shift.** The prior 3 buckets (✅ working /
⚠️ shaky / 🚧 gaps) collapse into 2 sections: "What's working"
(praise, plain bullets) and "Findings" (§6 severity tiers —
CRITICAL / HIGH / MEDIUM / LOW). The severity tier replaces the
shaky-vs-gap distinction with a more useful axis: how badly does
this hurt? A "gap" can be HIGH (security hole) or LOW (nice to
have); a "smell" can be HIGH (likely to break) or LOW (cosmetic).
Severity calibrates honesty better than category does.

Render exactly this shape. The whole report is the response — no
preamble like "Here's the audit", no closing "let me know if you
want…". The first heading is the deliverable.

````markdown
# Audit — <target>

> **TL;DR.** <one sentence on the overall read. Not "looks good" —
> something specific. e.g. "Solid read-side, write-side is half-built
> and inconsistent across modules.">

**Scope.** <files / directories actually read, comma-separated or
short list>
**Lines audited.** <approximate count>

---

## Part 1 — Architectural breakdown

### <Subsystem or layer name>

<2–4 sentences describing what this layer does and how it fits.>

```<lang>
// file_path:line_number
<minimal snippet illustrating the pattern>
```

<One sentence on why this snippet matters.>

### <Next subsystem>
…

*(Repeat for each meaningful layer. Typical layers: data/model,
firebase/IO, hooks, components, routing, styling. Skip layers that
aren't present.)*

### External libraries used in this slice

Document every external library, SDK, or third-party service
used in the audited code. Future task work targeting this area
will need to fetch current docs for these — capture the URLs
now so the next session doesn't re-discover.

| Library | Version | Used for | Docs |
|---|---|---|---|
| `<name>` | `<version>` | <one-line purpose in this slice> | <full doc URL> |
| `<name>` | `<version>` | <purpose> | <URL> |

Cite the version from the project's manifest (`package.json`,
`Package.swift`, `requirements.txt`, `build.gradle`, etc.).
For the doc URL, prefer the official source — Apple developer
docs, Android developer docs, package homepage. Skip the row
if a library's only used trivially (e.g. a stdlib helper).

---

## Part 2 — Honest assessment

### What's working

- **<short claim>** — <one-line why it's good, ideally with a file
  reference>
- …

*(Praise, plain bullets. No catalogue ornament — what's good
doesn't need a severity tier.)*

### Findings

```
▌ CRITICAL  ·  src/firebase/queries.ts:42
  useInspections joins notes by inspectionFormId but writes them
  under inspectionFormField — every note silently lost
  └─ fix the field name mismatch in writeNote

▌ HIGH      ·  src/components/Form.tsx:108
  duplicates validation logic across 3 files
  └─ extract to shared schema

▌ MEDIUM    ·  src/hooks/useAuth.ts:15
  no error boundary around auth state
  └─ add fallback for null user

▌ LOW       ·  src/utils/format.ts:88
  inconsistent date format ("2026/04/30" vs "2026-04-30")
  └─ standardize on ISO
```

*(§6 Severity audit format. Severity calibration:*
- *CRITICAL — bug, security issue, data loss/corruption, app
  breakage. The kind of thing that requires action this week.*
- *HIGH — real architectural flaw, gap likely to bite, missing
  thing that should exist. Action needed this batch.*
- *MEDIUM — smell or rough edge worth cleaning up. Doesn't bite
  today, but it will.*
- *LOW — nit, cosmetic, future polish. Worth noting, not worth
  prioritizing.*

*Drop tiers with no findings — don't render an empty CRITICAL
section to say "no critical issues". If there are zero findings
across all tiers, render a §26 Empty state instead of an empty
Findings section.)*

### Tradeoffs worth naming

<2–5 sentences on the genuine tradeoffs the current design makes.
Not "pros and cons" theatre — the real ones. e.g. "Choosing RTDB
over Firestore costs you query power but buys you cheaper real-time
fan-out, which matches the iOS app's pattern.">

---

## Bottom line

<2–4 sentences. What would you do next if this were yours? Be
direct. If the answer is "leave it alone, it's fine", say that.
If the answer is "this needs a rewrite before adding more", say
that too — and say why.>

*(Optional)* **Adjacent observations.** <one or two lines on stuff
just outside the audit scope that the reader should know about.>
````

## Style rules

- **Render structured deliverables per `output-rules.md`.** The
  Findings section is §6 Severity audit; the rest is markdown
  prose with code snippets. Glyph and color discipline follow
  the canonical set in `output-rules.md`.
- **Visual rhythm matters.** Use the horizontal rules (`---`)
  between Part 1, Part 2, and Bottom line. They make the report
  scannable.
- **Severity is a calibration tool, not a sorting trick.** Don't
  inflate everything to HIGH because the audit "found problems."
  Don't bury real issues at LOW because the codebase is mostly
  fine. Each tier means something specific — see the calibration
  in the template.
- **Bold the claim, then dash, then the reason.** Applies to the
  "What's working" bullets and the inside of finding rows.
  `- **Claim** — reason.`
- **Code snippets ≤ 15 lines.** If you need more, link with
  `file_path:line_start-line_end` and summarize in prose.
- **Cite files as `path:line`.** Renders as a click-through link
  in the chat. Inside §6 finding rows, the file path goes after
  the `·` separator.
- **No trailing "hope this helps".** End on the Bottom line (or
  the Adjacent observations footer).

## What "honest" looks like in Part 2

Per CLAUDE.md: no narratives, no soft no's, no soft yes's.

- "The hooks are clean." — fine if they are.
- "There's a real bug here: `useInspections` joins notes by
  `inspectionFormId` but writes them under `inspectionFormField`.
  This will silently lose every note." — fine, that's a verified
  claim about the code.
- "This could potentially be improved by considering a refactor in
  the future." — **don't write this.** It says nothing. Either
  there's a concrete improvement worth naming or there isn't.
- "I don't know how this handles offline state — couldn't verify
  from the code." — **good.** Saying I-don't-know is part of the
  contract.

## When NOT to use this skill

- **Architecture planning for new work** → use `/plan`. Audit looks
  at what exists; plan looks at what should.
- **Filing follow-up tasks from an audit** → use `/task` after the
  audit, not inside it.
- **Reviewing a single small file** (< ~50 lines) → just read it
  inline; the two-part structure is overkill.
- **Reviewing a PR or diff** → that's `/ultrareview` or a normal
  review request, not this.
- **Listing what skills exist** → use `/skills`.

## What "done" looks like for a /audit session

A single rendered report following the structure above, displayed
in chat **and** saved to `docs/audits/<YYYY-MM-DD>-<target-slug>.md`
uncommitted. No source-code edits, no commits, no task filings.
The user reads it, decides what (if anything) to act on next, and
can `git diff` + commit the saved audit when ready. Past audits
under `docs/audits/` are durable context for future sessions.
