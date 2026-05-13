// RTDB mirror for repo snapshots.
//
// Keeps /repos/<id> in sync with the local app.db after every
// extract / refresh / register / delete. The companion subscribes to
// /repos and re-renders whenever any repo changes — no command
// round-trip needed.
//
// RTDB layout:
//   /repos/<id>  — one doc per registered active repo, replaced wholesale.
//                  Deleted when the repo is unregistered.
//
// All writes are fire-and-forget (void). A failed push never blocks
// the local feature path — SQLite is still the source of truth.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import {
  listRepos,
  listRepoPhases,
  listRepoTasks,
  listRepoAuditEntries,
  listOpenPRsForRepo,
} from './db/app.js';
import { getMirrorDb } from './firebase.js';

const execFileP = promisify(execFile);

const STALE_DAYS = 10;   // mirror-local copy — avoids circular import with repo-watcher.ts

function resolveBin(name: string, candidates: string[]): string {
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* skip */ }
  }
  return name;
}
const GH_BIN = resolveBin('gh', ['/opt/homebrew/bin/gh', '/usr/local/bin/gh', '/home/linuxbrew/.linuxbrew/bin/gh']);

interface GhPR {
  number:      number;
  title:       string;
  url:         string;
  headRefName: string;
  body:        string;
}

/** Fetch all open PRs for a local git repo via `gh pr list`. Returns [] on any error. */
async function fetchGitHubPRs(repoPath: string, repoId: number, repoName: string): Promise<Array<{ task_id: string | null; pr: Record<string, unknown> }>> {
  try {
    const { stdout } = await execFileP(
      GH_BIN,
      ['pr', 'list', '--state', 'open', '--json', 'number,title,url,headRefName,body', '--limit', '25'],
      { cwd: repoPath, timeout: 15_000, env: { ...process.env } },
    );
    const ghPRs: GhPR[] = JSON.parse(stdout.trim() || '[]');

    // Merge with Galt-tracked PRs from app.db so we preserve task_id linkage.
    const trackedByNumber = new Map(
      listOpenPRsForRepo(repoId).map((x) => [x.pr.number as number, x]),
    );

    return ghPRs.map((g) => {
      const tracked = trackedByNumber.get(g.number);
      return {
        task_id: tracked?.task_id ?? null,
        pr: {
          number:    g.number,
          title:     g.title,
          url:       g.url,
          branch:    g.headRefName,
          body:      g.body,
          state:     'open',
          repo_id:   repoId,
          repo_name: repoName,
          ...(tracked?.pr ?? {}),  // overlay Galt metadata (won't override gh fields)
        },
      };
    });
  } catch {
    // gh not authenticated, no network, not a gh-connected repo — fall back to app.db only.
    return listOpenPRsForRepo(repoId);
  }
}

async function buildPayload(repoId: number): Promise<Record<string, unknown> | null> {
  const repos = listRepos({ activeOnly: false });
  const repo = repos.find((r) => r.id === repoId);
  if (!repo) return null;

  const now = Date.now();
  const phases       = listRepoPhases(repoId);
  const activeTasks  = listRepoTasks(repoId, { state: 'active' });
  const backlogTasks = listRepoTasks(repoId, { state: 'backlog' });
  const doneTasks    = listRepoTasks(repoId, { state: 'done' });
  const audit        = listRepoAuditEntries(repoId, 5);
  const openPRs      = await fetchGitHubPRs(repo.local_path, repoId, repo.name);

  function serializeTask(t: ReturnType<typeof listRepoTasks>[number]) {
    return {
      task_id:   t.task_id,
      title:     t.title,
      phase_num: t.phase_num,
      is_stub:   !!t.is_stub,
      body:      t.body ?? null,
      days:      t.mtime != null ? Math.floor((now - t.mtime) / 86400000) : null,
      stale:     t.mtime != null && (now - t.mtime) / 86400000 >= STALE_DAYS,
    };
  }

  return {
    id:       repo.id,
    name:     repo.name,
    company:  repo.company,
    platform: repo.platform,
    branch:   repo.branch,
    active:   repo.active,
    phases: phases.map((p) => ({
      phase_num: p.phase_num,
      name:      p.name,
      status:    p.status,
    })),
    active_tasks:  activeTasks.map(serializeTask),
    backlog_tasks: backlogTasks.map(serializeTask),
    done_tasks:    doneTasks.slice(-20).reverse().map(serializeTask),
    stale_count:   activeTasks.filter(
      (t) => t.mtime != null && (now - t.mtime) / 86400000 >= STALE_DAYS,
    ).length,
    backlog_count: backlogTasks.length,
    done_count:    doneTasks.length,
    open_pr_count: openPRs.length,
    open_prs:      openPRs,
    audit: audit.map((e) => ({
      date:  e.entry_date,
      emoji: e.emoji,
      text:  e.text,
    })),
    updated_at: now,
  };
}

/** Push (replace) /repos/<id> with the current DB snapshot. Fire-and-forget. */
export async function pushRepoSnapshot(repoId: number): Promise<void> {
  const db = getMirrorDb();
  if (!db) return;
  const payload = await buildPayload(repoId);
  if (!payload) return;
  try {
    await db.ref(`/repos/${repoId}`).set(payload);
    console.log(`[firebase-repos] set repoId=${repoId} name=${payload.name}`);
  } catch (err) {
    console.error(`[firebase-repos] set failed repoId=${repoId}:`, (err as Error).message);
  }
}

/** Push all active repos in parallel. Used on boot and manual refresh. */
export async function pushAllRepoSnapshots(): Promise<void> {
  const repos = listRepos({ activeOnly: true });
  await Promise.all(repos.map((r) => pushRepoSnapshot(r.id)));
}

/** Remove /repos/<id> — call when a repo is unregistered. */
export async function mirrorDeleteRepo(repoId: number): Promise<void> {
  const db = getMirrorDb();
  if (!db) return;
  try {
    await db.ref(`/repos/${repoId}`).remove();
    console.log(`[firebase-repos] delete repoId=${repoId}`);
  } catch (err) {
    console.error(`[firebase-repos] delete failed repoId=${repoId}:`, (err as Error).message);
  }
}
