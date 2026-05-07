# imsg-ai

Local-only macOS iMessage assistant. Reads your `chat.db`, drafts replies in
your voice via OpenAI, sends via AppleScript only after you approve. Runs
as a LaunchAgent on your Mac, dashboard at `http://127.0.0.1:3000`.

Single-user. No cloud. No telemetry. Bind 127.0.0.1 only.

---

## Quickstart

Requires: macOS, Terminal access. Get an OpenAI API key from
[platform.openai.com/api-keys](https://platform.openai.com/api-keys) — you'll
paste it in via the dashboard once setup finishes (not into the terminal).

```bash
git clone <this-repo-url> imsg-ai
cd imsg-ai
./bin/setup
```

`./bin/setup` walks you through:

1. installing Node 22 (via nvm, asks consent first)
2. `npm install`
3. installing the LaunchAgent
4. **the one manual step** — granting Full Disk Access to the Node binary

Step 4 is the only piece macOS won't let scripts automate. The setup copies
the Node path to your clipboard and opens System Settings to the right pane,
then waits for you to confirm. Takes about 30 seconds.

Then open `http://127.0.0.1:3000` and:
- Sidebar → **Settings** → OpenAI section → paste your API key → **Save**

That's it. Without a key the dashboard still works for browsing chats —
just the AI buttons (drafting, summarization, voice profile, away mode,
calendar extraction, radar) will return 503 until you add one.

---

## What this needs from your machine

Be honest with yourself before installing — this app gets broad access:

- **Full Disk Access for Node** — required to read `~/Library/Messages/chat.db`.
  This means the same Node binary can read everything else under your user
  account too. You're trusting the code in this repo not to abuse it.
- **Automation → Messages** — granted on first send. Lets the app drive
  Messages.app via AppleScript to actually send approved replies.
- **OpenAI API access (optional)** — drafts/summaries/voice profile/away mode
  send context from your messages to OpenAI's API. The key you paste in
  Settings is stored locally in `data/app.db` (gitignored, never leaves the
  machine except in outbound calls to `api.openai.com`). Clear it any time
  via Settings → OpenAI → Clear key.

Nothing leaves your Mac except outbound calls to `api.openai.com`. The server
binds 127.0.0.1 only — nothing on your network can reach it.

---

## Day-to-day

```bash
./bin/status           # is it running, is chat.db readable, is OpenAI configured
./bin/doctor           # diagnose problems (checks 10 things, tells you what to fix)
./bin/logs             # tail logs (Ctrl-C to exit)
./bin/deploy           # apply code edits — typecheck, then restart the service
./bin/restart          # restart without typechecking
./bin/stop             # stop the service
./bin/start            # start it again
./bin/uninstall        # remove the LaunchAgent (your data in data/app.db stays)
./bin/reload-contacts  # force a fresh read of macOS Contacts after iCloud sync
```

If something's wrong, start with `./bin/doctor`. It pinpoints the most common
issues (FDA missing, OpenAI key blank, port in use, service crashed).

---

## What's where

| | |
|---|---|
| Server code | `server/*.ts` (Express, SQLite, OpenAI client, AppleScript send) |
| Frontend | `web/*` (static HTML + ES modules, no build step) |
| App database | `data/app.db` (gitignored, persists across reinstalls) |
| Config | `.env` (gitignored) |
| LaunchAgent plist | `~/Library/LaunchAgents/com.chazzromeo.imsg-ai.plist` |
| Service logs | `logs/imsg-ai.{out,err}.log` (gitignored) |
| Plist template | `launchd/com.chazzromeo.imsg-ai.plist.template` |

---

## Updating

```bash
git pull
./bin/deploy
```

`./bin/deploy` typechecks first, fails fast on errors, then restarts the
service in place. If the typecheck fails, your old version keeps running.

If a new release adds dependencies, `./bin/deploy` re-runs `npm install`
under the hood — no extra step needed.

---

## Uninstalling

```bash
./bin/uninstall              # remove the LaunchAgent
rm -rf ~/Library/Messages/<...>  # nothing to remove — we never wrote there
```

To fully remove: also revoke Full Disk Access for the node binary in
System Settings, and delete the project directory. `data/app.db` is the
only persistent state — drafts, watched contacts, monitor rules, voice
profile, away-mode contacts, radar memories.

---

## Limits & known issues

- **macOS only.** Won't run on Linux/Windows. `chat.db`, AppleScript, and
  Contacts are Apple-specific.
- **Node binary path is sticky.** If you upgrade Node via nvm, you'll need to
  re-grant Full Disk Access to the new binary path. `./bin/install` prints
  the path; `./bin/doctor` will tell you if it's missing.
- **One user, one Mac.** No multi-user, no auth, no remote access. If you
  want this on a different machine, `git clone` + `./bin/setup` there too.
- **AI cost.** No budget cap yet. Rough order: a draft is ~500 prompt + 100
  completion tokens with `gpt-4o-mini` — fractions of a cent. Watch
  `https://platform.openai.com/usage` if you're worried.
- **iCloud-synced messages.** If your Messages history is in iCloud and not
  yet downloaded locally, those messages aren't in `chat.db` and won't show.
  They appear once Apple syncs them down.
