// Repo watcher — polls registered repos every 5 minutes.
// Uses `git log --since` as a cheap change detector before running a
// full re-extract, so idle repos cost almost nothing.
//
// On change: updates the DB snapshot, then fires auto-notes for:
//   - tasks that have been in active/ too long (> STALE_DAYS)
//   - tasks that just moved to done/ since last poll
//   - 🚀/🔥 audit entries that appeared since last poll
//
// Same onSnapshot listener pattern as MessageWatcher.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
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
      // Cheap change check — skip full extract if no new commits.
      const lastSha = getRepoLastPollSha(repo.id);
      const { sha: currentSha } = await getHeadSha(repo.local_path);

      if (lastSha && currentSha && lastSha === currentSha) {
        // Nothing changed — still update poll timestamp, skip re-extract.
        upsertRepoSnapshot(repo.id, null, currentSha);
        return;
      }

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
