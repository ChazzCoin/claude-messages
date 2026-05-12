// Repo watcher — polls registered repos every 5 minutes.
// Uses `git log --since` as a cheap change detector before running a
// full re-extract, so idle repos cost almost nothing.
//
// On change: updates the DB snapshot, then fires auto-notes for:
//   - tasks that have been in active/ too long (> STALE_DAYS)
//   - tasks that just moved to done/ since last poll
//   - 🚀/🔥 audit entries that appeared since last poll
//
// SSH / private repos
// -------------------
// When a repo has auto_pull=1 the watcher runs `git pull --ff-only`
// before each extract so the snapshot tracks remote HEAD rather than
// the last manual pull.
//
// Under launchd the process doesn't inherit SSH_AUTH_SOCK from the
// user's shell session. We recover it via:
//   launchctl asuser <uid> launchctl getenv SSH_AUTH_SOCK
// That returns the same socket the user's terminal sees, which holds
// whatever keys they've added (including keys loaded from macOS Keychain
// via `ssh-add --apple-use-keychain`).
//
// Same onSnapshot listener pattern as MessageWatcher.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import os from 'node:os';
import {
  listRepos,
  upsertRepoSnapshot,
  getRepoLastPollSha,
  type RepoRow,
} from './db/app.js';
import {
  extractRepo,
  daysStale,
  type RepoSnapshot,
  type RepoTask,
} from './integrations/repo-monitor.js';

const execFileP = promisify(execFile);

const POLL_INTERVAL_MS = 5 * 60_000;   // 5 minutes
export const STALE_DAYS = 10;           // flag active tasks older than this

type SnapshotListener = (snapshot: RepoSnapshot, repo: RepoRow) => void;

/* ------------------------------------------------------------------ */
/* SSH agent discovery                                                  */
/* ------------------------------------------------------------------ */

/** Cache the SSH_AUTH_SOCK so we only run launchctl once per process. */
let cachedSshAuthSock: string | null | undefined = undefined;  // undefined = not yet resolved

/**
 * Find the SSH agent socket for the current user.
 *
 * Order of preference:
 *  1. Already in environment (dev / manual run with SSH agent in shell).
 *  2. Ask launchd for the socket (covers LaunchAgent / background service
 *     on macOS — the user's terminal session and the agent share the same
 *     socket returned by `launchctl asuser <uid> launchctl getenv SSH_AUTH_SOCK`).
 *
 * Returns null if no agent is reachable.
 */
async function getSshAuthSock(): Promise<string | null> {
  if (cachedSshAuthSock !== undefined) return cachedSshAuthSock;

  // 1. Inherited from the parent shell.
  if (process.env.SSH_AUTH_SOCK) {
    cachedSshAuthSock = process.env.SSH_AUTH_SOCK;
    return cachedSshAuthSock;
  }

  // 2. Ask launchd — works on macOS regardless of how the process started.
  try {
    const uid = process.getuid?.() ?? os.userInfo().uid;
    const { stdout } = await execFileP(
      'launchctl',
      ['asuser', String(uid), 'launchctl', 'getenv', 'SSH_AUTH_SOCK'],
      { timeout: 3_000 },
    );
    const sock = stdout.trim();
    if (sock) {
      cachedSshAuthSock = sock;
      console.log(`[repo-watcher] SSH_AUTH_SOCK: ${sock} (via launchctl)`);
      return cachedSshAuthSock;
    }
  } catch { /* launchctl not available or no agent */ }

  cachedSshAuthSock = null;
  console.log('[repo-watcher] SSH_AUTH_SOCK: none found — SSH pulls will be skipped');
  return null;
}

/* ------------------------------------------------------------------ */
/* Git pull helper                                                      */
/* ------------------------------------------------------------------ */

interface PullResult {
  ok: boolean;
  changed: boolean;   // true if new commits arrived
  message: string;
}

/**
 * Fast-forward pull from origin, optionally switching to a specific branch.
 *
 * If `branch` is set:
 *   1. `git fetch origin <branch>` — fetches without touching working tree
 *   2. `git checkout <branch>` — switches (creates local tracking branch on
 *      first run; no-op if already on it)
 *   3. `git merge --ff-only origin/<branch>` — advances HEAD
 *
 * If `branch` is null, just runs `git pull --ff-only` on whatever is
 * currently checked out.
 *
 * - BatchMode=yes: SSH fails immediately if agent can't auth (never hangs).
 * - StrictHostKeyChecking=accept-new: silently accepts new host keys.
 * - ff-only: never creates a merge commit.
 */
async function gitPull(repoPath: string, branch: string | null): Promise<PullResult> {
  const sock = await getSshAuthSock();

  const gitSshCmd = [
    'ssh',
    '-o', 'BatchMode=yes',
    '-o', 'StrictHostKeyChecking=accept-new',
    '-o', 'ConnectTimeout=10',
  ].join(' ');

  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_SSH_COMMAND: gitSshCmd,
    GIT_TERMINAL_PROMPT: '0',
  };
  if (sock) env.SSH_AUTH_SOCK = sock;

  const opts = { cwd: repoPath, timeout: 30_000, env };

  try {
    if (branch) {
      // 1. Fetch the target branch from origin.
      await execFileP('git', ['fetch', '--quiet', 'origin', branch], opts);

      // 2. Switch to it (creates local tracking branch if first time).
      await execFileP('git', ['checkout', '--quiet', branch], opts);

      // 3. Fast-forward merge.
      const { stdout } = await execFileP(
        'git', ['merge', '--ff-only', '--quiet', `origin/${branch}`], opts,
      );
      const changed = !stdout.includes('Already up to date');
      return { ok: true, changed, message: stdout.trim() || `up to date on ${branch}` };
    } else {
      // No branch override — pull whatever is checked out.
      const { stdout } = await execFileP('git', ['pull', '--ff-only', '--quiet'], opts);
      const changed = !stdout.includes('Already up to date');
      return { ok: true, changed, message: stdout.trim() || 'up to date' };
    }
  } catch (err) {
    const msg = (err as Error & { stderr?: string }).stderr?.trim()
      ?? (err as Error).message;
    return { ok: false, changed: false, message: msg };
  }
}

/* ------------------------------------------------------------------ */
/* Watcher                                                              */
/* ------------------------------------------------------------------ */

export class RepoWatcher {
  private pollTimer: NodeJS.Timeout | null = null;
  private listeners = new Set<SnapshotListener>();
  private started = false;
  private polling = false;

  isRunning(): boolean { return this.started; }

  start(): void {
    if (this.started) return;
    this.started = true;
    void this.drain();
    this.pollTimer = setInterval(() => void this.drain(), POLL_INTERVAL_MS);
    this.pollTimer.unref?.();
    console.log('[repo-watcher] started (5 min poll)');
  }

  stop(): void {
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = null;
    this.started = false;
    console.log('[repo-watcher] stopped');
  }

  onSnapshot(fn: SnapshotListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private async drain(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const repos = listRepos({ activeOnly: true });
      for (const repo of repos) {
        await this.pollRepo(repo);
      }
    } catch (err) {
      console.error('[repo-watcher] drain error:', (err as Error).message);
    } finally {
      this.polling = false;
    }
  }

  private async pollRepo(repo: RepoRow): Promise<void> {
    try {
      // --- 1. Auto-pull if enabled ---
      if (repo.auto_pull) {
        const pull = await gitPull(repo.local_path, repo.branch);
        if (!pull.ok) {
          // Non-fatal: log and continue with local state.
          console.warn(
            `[repo-watcher] pull failed for ${repo.name}: ${pull.message}`,
          );
        } else if (pull.changed) {
          console.log(`[repo-watcher] pulled new commits for ${repo.name}`);
        }
      }

      // --- 2. Cheap change check — skip full extract if SHA unchanged ---
      const lastSha = getRepoLastPollSha(repo.id);
      const { sha: currentSha } = await getHeadSha(repo.local_path);

      if (lastSha && currentSha && lastSha === currentSha) {
        // Nothing changed — still update poll timestamp, skip re-extract.
        upsertRepoSnapshot(repo.id, null, currentSha);
        return;
      }

      // --- 3. Full extract ---
      const snapshot = await extractRepo(repo.local_path);
      upsertRepoSnapshot(repo.id, snapshot, snapshot.latest_commit_sha);

      console.log(
        `[repo-watcher] extracted ${repo.name}: ` +
        `${snapshot.tasks.filter((t) => t.state === 'active').length} active tasks, ` +
        `${snapshot.phases.length} phases`,
      );

      for (const fn of this.listeners) {
        try { fn(snapshot, repo); } catch (err) {
          console.error('[repo-watcher] listener error:', (err as Error).message);
        }
      }
    } catch (err) {
      console.warn(`[repo-watcher] poll failed for ${repo.name}: ${(err as Error).message}`);
    }
  }
}

export const repoWatcher = new RepoWatcher();

/** Get HEAD sha from a repo path. */
async function getHeadSha(repoPath: string): Promise<{ sha: string | null }> {
  try {
    const { stdout } = await execFileP('git', ['rev-parse', 'HEAD'], {
      cwd: repoPath, timeout: 5_000,
    });
    return { sha: stdout.trim() || null };
  } catch {
    return { sha: null };
  }
}

/** Classify active tasks into stale / fresh buckets. */
export function classifyActiveTasks(tasks: RepoTask[]): {
  stale: RepoTask[];
  fresh: RepoTask[];
} {
  const active = tasks.filter((t) => t.state === 'active');
  const stale = active.filter((t) => daysStale(t.mtime) >= STALE_DAYS);
  const fresh = active.filter((t) => daysStale(t.mtime) < STALE_DAYS);
  return { stale, fresh };
}
