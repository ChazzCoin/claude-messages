# Home Screen Design Patterns

Design reference for the Galt companion PWA. Three first-class container
patterns govern every surface on the home screen. New features **must** use
one of these patterns — do not invent a fourth shape.

---

## Design Token Foundation

All patterns are built exclusively from these tokens. Never hardcode a color
or spacing value that has a token equivalent.

```css
/* Surface stack — darkest to lightest */
--bg:       #15110f   /* page background */
--bg-2:     #1d1815   /* inset / depressed surface */
--bg-3:     #251f1a   /* default card surface */
--bg-elev:  #2c2520   /* elevated / hover surface */

/* Borders */
--border:   #2c2520   /* default 1px border */
--border-2: #3b3128   /* stronger / hover border */

/* Text hierarchy */
--text:       #f3ece4   /* primary — headings, active labels */
--text-dim:   #b8a99a   /* secondary — body, sub-labels */
--text-faint: #756558   /* tertiary — metadata, timestamps */

/* Accent (warm amber) */
--accent:      #d49a6b
--accent-dim:  #a07549
--accent-glow: rgba(212, 154, 107, 0.15)

/* State colors */
--green:  #6dbb7d   /* ok / active / merged */
--red:    #d4585a   /* error / close / danger */
--yellow: #d4a85c   /* warning */

/* Shape */
--radius:    12px   /* standard card */
--radius-sm:  8px   /* inner elements */
--radius-lg: 18px   /* sheets / large overlays */

/* Shadows */
--shadow: 0 8px 32px rgba(0,0,0,0.4)   /* global sheet shadow */
```

---

## Pattern 1 — Quick Actions

**What it is.** A compact, self-contained tap target that controls a mode or
opens an editor. Shows current state inline. No navigation — the action
completes in place or opens a sheet.

**When to use.** Anything the user turns on/off, configures in one tap, or
triggers a one-shot action. Examples: Summon toggle, Away toggle, Away message
editor.

### Anatomy

```
┌─────────────────────────────┐  ← border: 1px solid --border
│  [icon]          [on/off]   │  ← toggle-top row
│                             │
│  Label                      │  ← toggle-label
└─────────────────────────────┘
     bg: --bg-3, radius: --radius, padding: 12px
```

**Active state** (data-on="true"):
- Background: `linear-gradient(135deg, var(--accent-glow), transparent)`
- Border: `var(--accent-dim)`
- Icon fill: `var(--accent)`, icon color: `var(--bg)`
- Badge color: `var(--accent)`

**Hover state:**
- Background: `var(--bg-elev)`
- Border: `var(--border-2)`
- Transition: `all 0.18s ease`

### Sub-elements

| Element | Role | Key CSS |
|---|---|---|
| `.toggle-icon` | 28×28px icon well | `border-radius: 8px; background: --bg-2` |
| `.toggle-state-badge` | on/off pill | `font-size: 10px; font-weight: 600; letter-spacing: 0.5px; text-transform: uppercase; border-radius: 999px; padding: 3px 8px` |
| `.toggle-label` | control name | `font-size: 13px; font-weight: 500` |

### Content-bearing variant (Away Box)

When a Quick Action needs to show live content (e.g. an away message preview),
extend with a label + clamped preview + edit affordance:

```
┌─────────────────────────────────── [✎] ┐
│  AWAY MESSAGE                 (label)  │
│  Heads down today, back at 3…  (text)  │
└────────────────────────────────────────┘
     gap: 10px; padding: 12px
```

- Label: `font-size: 10px; font-weight: 600; letter-spacing: 0.6px; text-transform: uppercase; color: --text-faint`
- Preview text: `font-size: 13px; color: --text-dim; -webkit-line-clamp: 3`
- Edit icon: `24×24px; border-radius: 6px; background: --bg-2` — on hover: `color: --accent`
- Visibility: **hide the entire component when the mode is off.** Don't show a disabled or empty state.

### HTML Template

```html
<!-- Toggle (Summon / Away) -->
<button class="toggle" data-toggle="[name]">
  <div class="toggle-top">
    <div class="toggle-icon"><!-- svg icon --></div>
    <div class="toggle-state-badge" data-id="[name]-badge">—</div>
  </div>
  <div class="toggle-label">[Name]</div>
</button>

<!-- Content-bearing (Away Box) -->
<button class="away-box" data-action="[action]">
  <div class="away-box-content">
    <div class="away-label">[SECTION LABEL]</div>
    <div class="away-text" data-id="[name]-display"></div>
  </div>
  <div class="away-edit-icon"><!-- svg pencil --></div>
</button>
```

---

## Pattern 2 — Quick Views

**What it is.** A navigational card that shows a live summary of a deeper
page. Tapping the header navigates; the body previews the content. Always
read-only — actions happen inside the destination page, not here.

**When to use.** Any time you want to surface a snapshot of a section on the
home screen without making the user navigate first. Examples: Briefing
preview, Notes preview.

### Anatomy

```
┌─────────────────────────────────────┐
│  Title           [badge]        [›] │  ← quick-view-header (tappable)
├─────────────────────────────────────┤  ← border-bottom: 1px solid --border
│  preview content (clamped)          │  ← quick-view-body
└─────────────────────────────────────┘

border-left: 3px solid --accent    ← the defining stripe
border-radius: --radius
box-shadow: 0 2px 12px rgba(0,0,0,0.22)
```

**Header gradient:**
```css
background: linear-gradient(to right,
  color-mix(in srgb, var(--accent) 8%, var(--bg-3)) 0%,
  var(--bg-3) 60%);
```

On hover: accent strength increases to 14%, base to `--bg-elev`.

**Card hover:** `box-shadow: 0 4px 20px rgba(0,0,0,0.32), 0 0 0 1px rgba(212,154,107,0.12)`

**Arrow animation:** `transform: translateX(3px)` on `.quick-view:hover .quick-view-arrow`

### Sub-elements

| Element | Role | Key CSS |
|---|---|---|
| `.quick-view-title` | section name | `font-size: 13px; font-weight: 700; letter-spacing: 0.015em; color: --text` |
| `.quick-view-badge` | live count / date | `font-size: 10.5px; font-weight: 600; background: color-mix(accent 18%); color: --accent; border-radius: 10px; padding: 1px 7px` |
| `.quick-view-arrow` | nav cue | `color: --accent; transition: transform 0.15s` |
| `.quick-view-body` | content mount | no padding — children own their padding |
| `.quick-view-empty` | empty state | `padding: 14px; font-size: 13px; color: --text-faint; font-style: italic` |

**Body content items** (inside `.quick-view-body`) own their own padding
(`12px 14px`) and hover background (`--bg-elev`). They clamp their text:

- Summary text: `-webkit-line-clamp: 2` or `3`, `color: --text-dim`, `line-height: 1.45–1.55`

### HTML Template

```html
<div class="quick-view">
  <div class="quick-view-header" data-action="[open-action]">
    <span class="quick-view-title">[Section Name]</span>
    <span class="quick-view-badge" data-id="[name]-badge">—</span>
    <span class="quick-view-arrow"><!-- chevron svg --></span>
  </div>
  <div class="quick-view-body" data-id="[name]-preview">
    <!-- JS-rendered: .quick-view-note or .quick-view-standup items -->
  </div>
</div>
```

---

## Pattern 3 — Renderables

**What it is.** A data-driven card rendered from live state (RTDB, app.db).
Carries a custom accent color (company / group color) that overrides the
default amber accent. Has a structured header band, a stats strip, and
optional embedded interactive sub-elements (PR chips). Clicking navigates
to a detail view.

**When to use.** Any live entity list rendered from the store — repos, groups,
contacts, projects. If it comes from data and represents a "thing", it's a
Renderable.

### Anatomy

```
┌╴╴╴╴╴ 3px company-color left border ╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴╴┐
│  ● Repo Name                                           ›    │  ← brp-repo-top
│    ⎇ branch-name                                           │
├────────────────────────────────────────────────────────────┤  ← border-bottom
│  3 PR · 5 active · 12 backlog · 47 done · ● ● ○           │  ← brp-repo-stats
├────────────────────────────────────────────────────────────┤
│  [PR chip] [PR chip →]                                     │  ← brp-pr-rail (optional)
└────────────────────────────────────────────────────────────┘

border-left: 3px solid [company-color]     ← inline style
background: [company-color, 12% opacity]   ← inline style
box-shadow: -3px 0 14px [company-color]40  ← inline style (glow)
           + 0 2px 12px rgba(0,0,0,0.22)  ← base shadow
border-radius: --radius
overflow: hidden
margin-bottom: 10px
```

**Section dividers** (group / company labels above a set of cards):
```
[COMPANY NAME] ─────────────────────
font-size: 10px; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase
The line: flex: 1; height: 1px; background: --border
```

### Header band (`.brp-repo-top`)

- Padding: `11px 14px 9px`
- Border-bottom: `1px solid --border`
- Gradient: `linear-gradient(to right, rgba(0,0,0,0.12) 0%, transparent 70%)` — darkens left edge so company color reads cleanly

| Element | Role | Key CSS |
|---|---|---|
| `.brp-repo-dot` | status indicator | `7×7px; border-radius: 50%` — `.ok` = green glow, `.warn` = accent glow |
| `.brp-repo-name` | entity name | `font-size: 14px; font-weight: 600; color: --text; text-overflow: ellipsis` |
| `.brp-repo-sub` | meta (branch, etc.) | `font-size: 11px; color: --text-faint` |
| `.brp-repo-chevron` | nav cue | `color: --text-faint` → on hover: `translateX(2px); color: --text-dim` |

### Stats strip (`.brp-repo-stats`)

- Padding: `7px 14px 8px`; `font-size: 11px`
- Pills separated by `1px solid --border` dividers
- Stat number weights: `font-weight: 700; color: --text-dim`
- Active state: `color: --text` (full brightness)
- Has-PRs state: `color: --accent`

### PR chip rail (`.brp-pr-rail`)

Horizontal scroll only. Appended to the card when open PRs exist.

- `overflow-x: auto; scroll-snap-type: x mandatory; scrollbar-width: none`
- `padding: 0 14px 10px`
- Chips: `flex: 0 0 220px; border-radius: 9px; background: --bg-2; border: 1px solid --border-2`
- Merge button: tinted green (`color-mix(green 12%)`) → solid green on hover
- Close button: tinted red (`color-mix(red 10%)`) → solid red on hover
- The rail carries `data-action-stop` to prevent the card's navigate action from firing when tapping chips

### Hover & interaction

- Card hover: `box-shadow: 0 4px 20px rgba(0,0,0,0.34), 0 0 0 1px rgba(212,154,107,0.1)`
- Card active: `filter: brightness(1.12)`
- Transition: `box-shadow 0.18s, border-color 0.18s`

### HTML Template (JS-rendered)

```html
<!-- Section divider (rendered once per group) -->
<div class="brp-co-divider">
  <span class="brp-co-name" style="color:[company-color]">[COMPANY]</span>
  <span class="brp-co-line"></span>
</div>

<!-- Repo card -->
<div class="brp-repo-row" data-action="open-repo" data-repo-id="[id]"
     style="border-left-color:[color]; background:[color,12%]; box-shadow:-3px 0 14px [color]40">
  <div class="brp-repo-top">
    <span class="brp-repo-dot [ok|warn]"></span>
    <div class="brp-repo-info">
      <span class="brp-repo-name">[Name]</span>
      <div class="brp-repo-sub"><span class="brp-branch">⎇ [branch]</span></div>
    </div>
    <span class="brp-repo-chevron">›</span>
  </div>
  <div class="brp-repo-stats">
    <div class="brp-stat-pill"><span class="brp-stat-num has-prs">3</span><span>PRs</span></div>
    <div class="brp-stat-pill"><span class="brp-stat-num has-active">5</span><span>active</span></div>
    <!-- etc. -->
  </div>
  <!-- PR rail — omit when no open PRs -->
  <div class="brp-pr-rail" data-action-stop>
    <div class="brp-pr-chip" style="border-color:[color]33">
      <div class="brp-pr-chip-top">
        <span class="brp-pr-chip-num">#50</span>
        <a class="brp-pr-chip-view" href="[url]" target="_blank">↗</a>
      </div>
      <div class="brp-pr-chip-title">[PR title]</div>
      <div class="brp-pr-chip-branch">⎇ [branch]</div>
      <div class="brp-pr-chip-actions">
        <button class="brp-pr-chip-merge" data-action="approve-pr"
                data-task-id="[id]" data-repo-id="[id]" data-pr-number="[n]">✓ Merge</button>
        <button class="brp-pr-chip-close" data-action="deny-pr"
                data-task-id="[id]" data-repo-id="[id]" data-pr-number="[n]">✗ Close</button>
      </div>
    </div>
  </div>
</div>
```

---

## Rules for New Features

1. **Pick the pattern before writing a line of CSS.** Is it a control/mode toggle → Quick Action. Is it a peek at a deeper section → Quick View. Is it a live data entity → Renderable.

2. **Use tokens, not hardcoded values.** Every color, radius, and spacing value must reference a `--var`. The only exception is the per-entity accent color (company/group), which is computed and applied inline.

3. **Quick Actions are always visible or hidden — never disabled.** If the action isn't available, hide the component (`display: none`). Don't show grayed-out unavailable states.

4. **Quick Views never contain actions.** Tapping the header navigates. Content items can be individually tappable (to navigate deeper), but no buttons, no toggles, no mutations live inside a Quick View body.

5. **Renderables own their accent color.** The `--accent` token is the default; Renderables override it per-entity via inline style on `border-left-color`, `background`, and `box-shadow`. This is the only sanctioned place for inline color styles.

6. **Embedded interactive sub-elements inside Renderables use `data-action-stop`.** Any zone inside a Renderable card that has its own click behavior must carry `data-action-stop` to prevent the card-level navigate action from firing.

7. **Margin between cards is always `margin-bottom: 10–14px`** (Quick Actions and Quick Views use 14px; Renderables use 10px). Never use `gap` on the container when item margins do the same job.

8. **Hover is always a single property change** — either `background` (Actions), `box-shadow` (Views and Renderables), or `color` (inline elements). Never hover-animate more than two properties simultaneously. Transition speed: 0.12–0.20s.

9. **The left accent stripe is the Quick View's identity mark.** `border-left: 3px solid var(--accent)`. Renderables use the same stripe with entity color. No other component type uses a left stripe — it would conflict visually.

10. **Section labels above Renderables use the group/company color** applied to `.brp-co-name` via inline `style="color:[color]"`. The rule `.brp-co-name { transition: color 0.15s; }` applies globally — keep it.
