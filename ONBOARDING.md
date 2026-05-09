# Galt — installation & first-run guide

Galt is a **single-user, local-only iMessage AI assistant** that runs on
your Mac. It reads your `~/Library/Messages/chat.db` directly, classifies
incoming messages, and can either auto-respond when you're away (Away
mode) or join a conversation as a third voice when you summon it
(Summon mode). All processing happens locally; the only outbound network
calls are to OpenAI for AI features.

This guide walks a fresh Mac from `git clone` to a running dashboard at
`http://127.0.0.1:3000`. Time budget: **15–30 minutes** depending on how
fast you click through macOS permission dialogs.

If you'd rather have an AI agent install it for you, scroll to the
[Auto-install with Claude Code](#auto-install-with-claude-code) section
at the bottom.

---

## Is this for you?

Read this section before you start. If any of these are dealbreakers,
stop here and don't waste your time.

| | |
|---|---|
| **macOS only.** | Apple's `chat.db` and AppleScript only exist on macOS. There is no Linux or Windows port. No iOS port (it talks to your Mac's iMessage, not your phone). |
| **Single user.** | The dashboard binds to `127.0.0.1`. There is no auth. The companion remote-console (optional) has wide-open Firebase rules by default — don't deploy it publicly without first locking the rules down. |
| **You will grant macOS permissions.** | Full Disk Access (to read `chat.db`) and Automation → Messages (to send AppleScript). These are clicked in System Settings; no script can do it for you. |
| **You will need an OpenAI API key.** | Galt uses `gpt-4o-mini` by default. Most operations are cheap; you should still expect to spend a few dollars a month if you actively use AI features. |
| **Outbound messages are prefixed `Galt: `** | Recipients always know they're talking to your AI, not you. This is intentional. It's not configurable from the UI. |
| **This is a personal project.** | No support, no SLA, no roadmap commitments. Use it because you find it useful, not because someone promised you anything. |

If you're still here, let's go.

---

## Prerequisites

Before you start, you need:

- **A Mac** running macOS 13 (Ventura) or newer. iMessage configured and working.
- **Xcode Command Line Tools** for native module compilation
  (`better-sqlite3` is the main consumer):
  ```sh
  xcode-select --install
  ```
- **Git**. Comes with Xcode CLI tools.
- **Node.js ≥ 20.** The project pins to Node 22 via `.nvmrc`. The
  recommended path is `nvm`:
  ```sh
  curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.39.7/install.sh | bash
  # then close + reopen your shell
  nvm install 22
  ```
  If you prefer Homebrew Node, just make sure `node --version` shows
  `v20.x` or newer. The launcher script (`bin/run`) tries `nvm` first
  but falls back to whatever Node is on `$PATH`.
- **An OpenAI API key.** Get one at https://platform.openai.com/api-keys.

---

## Install

```sh
# 1. Clone
git clone https://github.com/ChazzCoin/claude-messages.git galt
cd galt

# 2. Pin Node + install deps
nvm use            # honors .nvmrc → Node 22
npm install        # ~30s; compiles better-sqlite3 native bindings

# 3. Configure
cp .env.example .env
# Open .env in your editor and set OPENAI_API_KEY=sk-...
# Other env vars are optional; defaults work for everything else.

# 4. Quick sanity check — does the server boot?
npm run dev
# You should see "galt listening on http://127.0.0.1:3000"
# Open that URL. If the dashboard loads, kill the dev server (Ctrl+C)
# and continue. If chat.db shows FAIL, you need permissions — read on.
```

---

## macOS permissions (the part that trips everyone up)

macOS guards `chat.db` and Messages.app with two separate permission
systems. You'll need to grant both.

### 1. Full Disk Access — for the Node binary

`chat.db` is in `~/Library/Messages/`, which macOS treats as protected.
Any process that wants to read it needs Full Disk Access **for that
specific binary**.

For development (`npm run dev`):
- Grant Full Disk Access to your **Terminal** (or iTerm, whichever
  shell you use). Already done? Good.

For production (running as a `launchd` service — see next section):
- The LaunchAgent runs `node` directly, NOT through Terminal. The
  Terminal grant doesn't inherit. You'll need to grant FDA to the
  specific Node binary the LaunchAgent uses. The exact path is shown
  by `./bin/install` — example: `/Users/you/.nvm/versions/node/v22.22.2/bin/node`.

How to grant:
1. Open **System Settings → Privacy & Security → Full Disk Access**.
2. Click `+` (the lock may need unlocking with your admin password).
3. Press `⌘⇧G` and paste the Node path you want to grant.
4. Toggle the switch to ON.

If you upgrade Node via nvm later, the path changes — you'll need to
re-grant. To avoid that churn, you can point the LaunchAgent at a
stable Node path (e.g., Homebrew's `/opt/homebrew/bin/node`) by editing
`bin/run` to skip nvm.

### 2. Automation → Messages

When Galt sends a message via AppleScript for the first time, macOS
will pop a dialog asking whether the process can control Messages.app.
**Click Allow.** That grant persists.

If you accidentally clicked Don't Allow, fix it in:
**System Settings → Privacy & Security → Automation → [your shell or Node binary] → Messages.app**

### 3. Verify

```sh
npm run dev
# In another terminal:
curl http://127.0.0.1:3000/api/health | python3 -m json.tool
# Look for: "chat_db": { "ok": true, ... }
```

If `chat_db.ok` is `true`, you're good. If `false` with `EPERM`, FDA
isn't granted to whatever binary is currently running.

---

## Run as a service (recommended)

For day-to-day use, you want Galt running in the background, restarting
on login, with logs and deploy scripts. Galt ships a LaunchAgent setup
for this.

```sh
# One-time install — registers the LaunchAgent, starts it
./bin/install
./bin/status      # confirms it booted + /api/health is responding
```

**Daily commands:**

| | |
|---|---|
| `./bin/deploy` | Typecheck → restart → tail new errors. The keystone command after pulling code changes. |
| `./bin/logs` | Tail stdout + stderr live. Ctrl-C to exit. |
| `./bin/status` | One-shot health check. |
| `./bin/restart` | Zero-downtime swap. |
| `./bin/stop` / `./bin/start` | Manual control. Stop will NOT auto-restart. |
| `./bin/uninstall` | Remove the LaunchAgent entirely. |
| `./bin/reload-contacts` | Force a contacts re-read after iCloud sync. |

**For active development:** stop the service, run `npm run dev` for
hot-reload, then start the service back up when you're done:

```sh
./bin/stop
npm run dev        # Ctrl-C to exit
./bin/start
```

Both can't bind port 3000 at the same time.

---

## First-time configuration

Open `http://127.0.0.1:3000` in your browser. The dashboard should load.

### A. Confirm the foundation

- Top-bar pills should be green: `chat.db`, `watcher`, `gpt-4o-mini`.
- If `chat.db` is red → FDA permissions missing for the running binary.
- If model pill says `warn` → no OpenAI key. Set it (see B).

### B. OpenAI key

Two options:

1. **In `.env`** — `OPENAI_API_KEY=sk-...`. Restart needed (`./bin/restart`).
2. **In the dashboard** — go to `Settings → OpenAI`, paste the key,
   save. Stored in `data/app.db` (overrides the env var). No restart
   needed.

### C. Galt's voice profile

Galt is a system-wide AI persona — every AI message it sends is
prefixed `Galt:`. Tell it how to sound.

- Open the **Galt page** (`/#/galt`).
- In the **Universal** stage, find **Galt's voice** (the data input
  node alongside Universal base prompt).
- Write a few lines describing how Galt should write. Example:
  ```
  direct, no hedging. iMessage-short — usually one line.
  light dry humor when it fits. avoid emojis unless the
  recipient leans on them.
  ```
- Save.

This text feeds the voice-profile wrapper on every AI call.

### D. Set the away greeting

Open the **Galt page** → **Pre-AI** stage → **Greeting**. This is the
literal first reply sent when an opted-in contact pings you while
away mode is on. Default is fine but personalize it:

```
Hey, this is Galt — Chazz's AI assistant.
He's away right now, but I can keep things moving in the meantime.
He'll catch up properly when he's back.
```

Supports `{recipientName}` and `{userName}` placeholder substitution.

### E. Add watched contacts (Away mode)

Go to **Away** in the sidebar. Add the contacts whose messages should
trigger Galt's auto-replies when away mode is on. **Only watched
contacts get auto-replies** — unwatched contacts get nothing, no
matter what mode you're in.

### F. Toggle modes from Home

Use the **Switches** panel on the home dashboard:

- **Auto Notes** — 24/7 inbound message triage; extracts follow-up
  items into a notes queue. Default on.
- **Summon** — when on, typing the trigger phrase (default `GALT!!`)
  in any chat invokes Galt as a third voice.
- **Away** — when on, watched contacts get the greeting + AI auto-replies.

---

## Optional: companion remote console

Galt ships an optional Firebase-hosted PWA (`frontend/galt-messages/`)
that lets you control the app from your phone — toggle Away/Summon,
edit the greeting, view auto-notes. Skip this section if you don't
want it.

**You will need:**
- A Firebase project of your own (you can't use Chazz's `msb-logistics`).
- `gcloud` CLI installed and authenticated.

**Setup:**
1. Create a Firebase project at https://console.firebase.google.com.
2. Enable Realtime Database and Hosting.
3. Update `.firebaserc` and `firebase.json` to point at your project +
   RTDB instance.
4. Update `frontend/galt-messages/js/firebase.js` with your project's
   web SDK config.
5. Authenticate locally:
   ```sh
   gcloud auth application-default login
   ```
6. Set `FIREBASE_DB_URL` in `.env` to your RTDB URL.
7. Restart Galt (`./bin/restart`). Logs should show
   `[firebase] init ok dbUrl=...`.
8. Deploy the frontend: `npm run remote:deploy`.

**⚠ Security note:** the default RTDB rules in
`database.galt-messages.rules.json` are wide-open (`.read: true`,
`.write: true`). That's intentional during single-user dev. **Before
deploying the companion site publicly, lock down the rules.** See
"Pause points" in the project's `CLAUDE.md` for the full lockdown
recipe (Firebase Auth + UID-scoped rules).

---

## Troubleshooting

| Symptom | Likely cause + fix |
|---|---|
| `chat.db FAIL: EPERM` in dashboard | Full Disk Access not granted to the running binary. Run `./bin/install` again to print the exact path you need to grant, then add it in System Settings. |
| Dashboard shows but no chats load | Same as above — chat.db unreadable. |
| AI features return 503 | `OPENAI_API_KEY` missing. Set in `.env` or via Settings UI. |
| `EADDRINUSE :3000` on boot | Another process owns port 3000. Common culprit: macOS AirPlay Receiver. Either turn that off (System Settings → General → AirDrop & Handoff → AirPlay Receiver) or change `PORT` in `.env`. |
| Service won't stay running | `./bin/logs` and look at `logs/galt.err.log`. Most likely missing FDA. |
| Messages.app permission popup keeps appearing | Click Allow once. If it persists, check Privacy & Security → Automation. |
| `npm install` fails on `better-sqlite3` | Xcode CLI tools missing. Run `xcode-select --install`. |
| LaunchAgent installed but `./bin/status` fails | Run `./bin/start` to start it. The LaunchAgent only auto-starts at login. |

---

## Architecture (brief)

If you want to understand what you're running:

- **Backend**: Node 22 + TypeScript + Express, SQLite via `better-sqlite3`.
- **Frontend**: Vanilla JS modules, no bundler, served as static files
  by the same Express process.
- **Two databases**:
  - `~/Library/Messages/chat.db` (Apple's, opened **read-only**, never
    written to)
  - `data/app.db` (Galt's own — drafts, contacts, settings, prompts,
    notes, calendar proposals, monitor flags, radar signals, etc.)
- **Watcher**: `node:fs.watch` on `chat.db-wal` triggers re-reads.
- **AI**: OpenAI's chat completions API. Default `gpt-4o-mini`. All
  prompt assembly is data-driven from `PIPELINE_STAGES` in
  `server/ai.ts`. The pipeline visualization on the Galt page is
  rendered from that same constant — single source of truth.
- **Send path**: AppleScript via `osascript`. iMessage send works
  reliably; SMS (green-bubble) is flakier and not officially supported.

For the full architectural notes — schema ownership, gated files,
deploy flow, pause points, etc. — read `CLAUDE.md` in the repo root.

---

## Auto-install with Claude Code

If you have [Claude Code](https://claude.com/claude-code) installed,
you can have it walk you through setup interactively. From the cloned
repo:

```sh
claude
```

Then paste:

> Set up this project. Read CLAUDE.md and ONBOARDING.md, then:
> 1. Confirm Node 22 is active (nvm use)
> 2. Run npm install
> 3. Help me create .env from .env.example
> 4. Boot the dev server and check /api/health
> 5. Tell me exactly which macOS permissions to grant and where
> 6. After I confirm permissions, install the LaunchAgent and verify
>    ./bin/status shows green across the board

Claude Code will run through all of that, stop at the macOS
permission grants (which only you can click), and resume after you
confirm. It will ask for your OpenAI key rather than fabricating one.

---

## What this is NOT

- Not a SaaS. There is no hosted version.
- Not multi-user. The dashboard has no auth and is bound to `127.0.0.1`.
- Not a phone app. It runs on your Mac, talks to your Mac's iMessage.
- Not for messaging at scale. It's for one person's iMessage life.
- Not maintained on a release schedule. Personal project.
- Not a replacement for being present in your relationships. Galt
  covers, defers, and flags for follow-up. It is not a way to outsource
  the people who matter to you.

---

If something here is wrong or unclear, the source of truth is the code
and `CLAUDE.md`. Patches welcome.
