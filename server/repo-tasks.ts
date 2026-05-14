// Repo task runner helpers — git branch/push and gh PR operations.
//
// Called by the `start_repo_task` command after Claude finishes work,
// and by `approve_pr` / `deny_pr` for the PR lifecycle.
//
// All git/gh calls use the same SSH agent resolution as the watcher
// so they work correctly under launchd where SSH_AUTH_SOCK isn't
// inherited from the user's shell.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { getSshAuthSock } from './repo-watcher.js';

const execFileP = promisify(execFile);

/* ------------------------------------------------------------------ */
/* Tool resolution — find gh/git at absolute paths for launchd safety  */
/* ------------------------------------------------------------------ */

/** Resolve an executable by checking candidate absolute paths first,
 *  then falling back to the bare name (relies on PATH). Launchd strips
 *  /opt/homebrew/bin from PATH so we probe common Homebrew locations. */
function resolveBin(name: string, candidates: string[]): string {
  for (const p of candidates) {
    try { fs.accessSync(p, fs.constants.X_OK); return p; } catch { /* skip */ }
  }
  return name;  // fallback — works when running under npm run dev
}

const GH_BIN = resolveBin('gh', [
  '/opt/homebrew/bin/gh',
  '/usr/local/bin/gh',
  '/home/linuxbrew/.linuxbrew/bin/gh',
]);

/* ------------------------------------------------------------------ */
/* SSH env builder                                                      */
/* ------------------------------------------------------------------ */

async function gitEnv(): Promise<NodeJS.ProcessEnv> {
  const sock = await getSshAuthSock();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o ConnectTimeout=15',
    GIT_TERMINAL_PROMPT: '0',
  };
  if (sock) env.SSH_AUTH_SOCK = sock;
  return env;
}

/* ------------------------------------------------------------------ */
/* Branch helpers                                                       */
/* ------------------------------------------------------------------ */

/** Convert a worktree name (what we pass as `--worktree <name>`) into the
 *  actual git branch name that the Claude CLI creates.
 *  The CLI prefixes "worktree-" and replaces every "/" with "+".
 *  e.g. "galt/T-042-fix-auth" → "worktree-galt+T-042-fix-auth" */
export function worktreeBranchName(worktreeName: string): string {
  return 'worktree-' + worktreeName.replace(/\//g, '+');
}

/** Convert a task_id like "T-042-fix-firebase-rules" into a valid
 *  git branch name under the "galt/" namespace. */
export function sanitizeBranchName(taskId: string): string {
  const slug = taskId
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `galt/${slug}`;
}

/** Create a new local branch from the current HEAD. Throws on failure. */
export async function createBranch(repoPath: string, branchName: string): Promise<void> {
  await execFileP('git', ['checkout', '-b', branchName], {
    cwd: repoPath, timeout: 10_000,
  });
  console.log(`[repo-tasks] created branch ${branchName} in ${repoPath}`);
}

/** Push branch to origin. Uses the SSH agent so it works under launchd. */
export async function pushBranch(repoPath: string, branchName: string): Promise<void> {
  const env = await gitEnv();
  await execFileP('git', ['push', 'origin', branchName], {
    cwd: repoPath, timeout: 60_000, env,
  });
  console.log(`[repo-tasks] pushed ${branchName}`);
}

/* ------------------------------------------------------------------ */
/* PR helpers — require `gh` CLI authenticated                         */
/* ------------------------------------------------------------------ */

export interface PrInfo {
  url:    string;
  number: number;
  title:  string;
  branch: string;
  body:   string;
}

/** Return the subject line of the most recent commit. Used as PR title
 *  for create operations where we don't know the title upfront. */
export async function getLastCommitMessage(repoPath: string): Promise<string> {
  const { stdout } = await execFileP(
    'git', ['log', '-1', '--pretty=%s'],
    { cwd: repoPath, timeout: 10_000 },
  );
  return stdout.trim() || 'New commit';
}

/** Find the filesystem path of a git worktree checked out on branchName.
 *  Returns null if no worktree for that branch is found (e.g. already
 *  removed, or the branch was never a worktree). */
export async function getWorktreePath(repoPath: string, branchName: string): Promise<string | null> {
  try {
    const { stdout } = await execFileP(
      'git', ['worktree', 'list', '--porcelain'],
      { cwd: repoPath, timeout: 10_000 },
    );
    // Each worktree block is separated by a blank line. A block looks like:
    //   worktree /abs/path
    //   HEAD abc123
    //   branch refs/heads/galt/T-042-foo
    for (const block of stdout.trim().split(/\n\n+/)) {
      const lines = block.split('\n');
      const pathLine   = lines.find((l) => l.startsWith('worktree '));
      const branchLine = lines.find((l) => l === `branch refs/heads/${branchName}`);
      if (pathLine && branchLine) return pathLine.slice('worktree '.length);
    }
  } catch { /* git not a repo or other error — fall through */ }
  return null;
}

/** Remove a git worktree by its absolute path. Uses --force so it
 *  works even when the worktree has uncommitted changes (task failed
 *  mid-run). Does not delete the branch — the branch stays so the PR
 *  remains open and the commits are reachable. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  await execFileP(
    'git', ['worktree', 'remove', '--force', worktreePath],
    { cwd: repoPath, timeout: 15_000 },
  );
  console.log(`[repo-tasks] removed worktree ${worktreePath}`);
}

/** Create a PR from branchName → default base branch.
 *  Returns the PR URL, number, and title.
 *  Note: `gh pr create` outputs only the URL to stdout — number is
 *  parsed from the URL path (.../pull/NNN). */
export async function createPR(
  repoPath: string,
  opts: { title: string; body: string; branch: string },
): Promise<PrInfo> {
  const { stdout } = await execFileP(
    GH_BIN, [
      'pr', 'create',
      '--title', opts.title,
      '--body',  opts.body,
      '--head',  opts.branch,
    ],
    { cwd: repoPath, timeout: 30_000 },
  );
  const url = stdout.trim();
  const numberMatch = url.match(/\/pull\/(\d+)$/);
  if (!numberMatch) throw new Error(`gh pr create returned unexpected output: ${url}`);
  const number = parseInt(numberMatch[1]!, 10);
  console.log(`[repo-tasks] PR #${number} created: ${url}`);
  return { url, number, title: opts.title, branch: opts.branch, body: opts.body };
}

/** Squash-merge a PR and delete the remote branch. */
export async function mergePR(repoPath: string, prNumber: number): Promise<void> {
  await execFileP(
    GH_BIN, ['pr', 'merge', String(prNumber), '--squash', '--delete-branch'],
    { cwd: repoPath, timeout: 30_000 },
  );
  console.log(`[repo-tasks] PR #${prNumber} merged`);
}

/** Close (reject) a PR and delete the remote branch. */
export async function closePR(repoPath: string, prNumber: number): Promise<void> {
  await execFileP(
    GH_BIN, ['pr', 'close', String(prNumber), '--delete-branch'],
    { cwd: repoPath, timeout: 30_000 },
  );
  console.log(`[repo-tasks] PR #${prNumber} closed`);
}

/* ------------------------------------------------------------------ */
/* Task spec reader                                                     */
/* ------------------------------------------------------------------ */

export interface TaskSpec {
  taskId:   string;
  filePath: string;   // relative to repoPath, e.g. tasks/backlog/T-042-...md
  state:    'backlog' | 'active' | 'done';
  content:  string;
  title:    string;   // first # heading or filename fallback
}

/** Scan tasks/backlog, tasks/active, tasks/done for a file whose name
 *  starts with taskId. Returns the first match. */
export function readTaskSpec(repoPath: string, taskId: string): TaskSpec {
  const states = ['backlog', 'active', 'done'] as const;
  for (const state of states) {
    const dir = path.join(repoPath, 'tasks', state);
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir);
    const match = files.find((f) => f.startsWith(taskId) && f.endsWith('.md'));
    if (!match) continue;
    const filePath = path.join('tasks', state, match);
    const content = fs.readFileSync(path.join(repoPath, filePath), 'utf8');
    // Extract first # heading as the title
    const headingMatch = content.match(/^#\s+(.+)/m);
    const title = headingMatch?.[1]?.trim() ?? match.replace(/\.md$/, '');
    return { taskId, filePath, state, content, title };
  }
  throw new Error(`task spec not found for ${taskId} in tasks/backlog|active|done`);
}

/* ------------------------------------------------------------------ */
/* Prompt builder                                                       */
/* ------------------------------------------------------------------ */

/** Build the minimal Claude prompt for a repo task (implementation).
 *  The repo's own CLAUDE.md supplies all project context — we just
 *  point at the spec file and give commit instructions. */
export function buildRepoTaskPrompt(spec: TaskSpec, repoName: string): string {
  return `You are working inside the ${repoName} repository.

Your job is to implement the task described below. The repository's CLAUDE.md, task-rules.md, and related .claude/ files contain all the conventions, tech stack, and instructions you need — follow them exactly.

Task ID: ${spec.taskId}
Spec file: ${spec.filePath}

--- TASK SPEC ---
${spec.content}
--- END SPEC ---

When you have completed the work:
1. Run the verification gate defined in CLAUDE.md (typecheck, tests, etc.) and confirm it passes.
2. Stage and commit all changes. Write a clear commit message that references the task ID.
3. Move the task file from tasks/backlog/ to tasks/done/ if it is in backlog (per task-rules.md convention).
4. Do NOT push the branch and do NOT ask about PR creation — a PR will be opened automatically for review upon completion. This is mandatory and requires no action from you.

Start now.`;
}

/** Build the prompt for speccing out a stub task.
 *  Claude reads the stub, does claude-kit research (reads existing code),
 *  and expands the file into a full spec with acceptance criteria. */
export function buildSpecTaskPrompt(spec: TaskSpec, repoName: string): string {
  return `You are working inside the ${repoName} repository.

Your job is to expand the stub task below into a full, grounded spec.

Task ID: ${spec.taskId}
Spec file: ${spec.filePath}

--- CURRENT STUB ---
${spec.content}
--- END STUB ---

Steps:
1. Read the repository's CLAUDE.md, .claude/task-rules.md, and .claude/task-template.md (if present) to understand the spec format and conventions.
2. Read the relevant source files to ground the spec in concrete reality — which files will change, what interfaces exist, what constraints apply.
3. Rewrite ${spec.filePath} as a full spec using the task-template.md format. Include:
   - Clear "What" and "Why" sections
   - Concrete acceptance criteria (checkboxes)
   - Files expected to change
   - Risks / out of scope
   Remove the stub marker if present.
4. Stage and commit: "spec(${spec.taskId}): expand stub to full spec"
5. Do NOT push and do NOT ask about PR creation — a PR will be opened automatically for review upon completion. This is mandatory and requires no action from you.

Start now.`;
}

/* ------------------------------------------------------------------ */
/* Narrative → Claude prompts for create operations                     */
/* ------------------------------------------------------------------ */

/** Build the Claude prompt for creating a new task from a free-form narrative.
 *  Claude reads the narrative + codebase and writes a real spec (not a stub). */
export function buildCreateTaskPrompt(narrative: string, repoName: string): string {
  return `You are working inside the ${repoName} repository.

A user wants to add a new task to the backlog. Here is their description of what they want:

--- USER NARRATIVE ---
${narrative}
--- END NARRATIVE ---

Your job:
1. Read the repository's CLAUDE.md, .claude/task-rules.md, and .claude/task-template.md (if present) to understand the conventions and spec format for this project.
2. Read existing task files in tasks/backlog/, tasks/active/, and tasks/done/ to understand the current task numbering (T-NNN format) and scope — pick the next available number.
3. Read whichever source files are relevant to understand the existing codebase shape so the spec is grounded in reality.
4. Create a single new task file in tasks/backlog/ following the project's task-template.md format. The file should be a FULL SPEC — not a stub. Fill in all sections concretely:
   - Clear title and task ID
   - What: what this does, precisely
   - Why: the user's intent from the narrative
   - Acceptance criteria: specific, checkboxable items
   - Files expected to change: real file paths
   - Out of scope: what this task deliberately does NOT cover
   - Risks: anything that could go wrong
5. Stage and commit: "backlog: add [TASK-ID] — [title]"
6. Do NOT push and do NOT ask about PR creation — a PR will be opened automatically for review upon completion. This is mandatory and requires no action from you.

Start now.`;
}

/** Build the Claude prompt for creating a new phase from a free-form narrative.
 *  Claude reads the narrative + existing phases + codebase, writes the phase entry,
 *  and generates task stubs for each piece of work it identifies. */
export function buildCreatePhasePrompt(narrative: string, repoName: string): string {
  return `You are working inside the ${repoName} repository.

A user wants to plan a new development phase. Here is their vision:

--- USER NARRATIVE ---
${narrative}
--- END NARRATIVE ---

Your job:
1. Read the repository's CLAUDE.md, .claude/task-rules.md, and tasks/PHASES.md to understand the existing phase structure and conventions.
2. Read existing task files to understand current task numbering and avoid duplicates.
3. Read relevant source files to understand what already exists — so the tasks you generate are grounded and don't duplicate shipped work.
4. Determine the next phase number from PHASES.md.
5. Append a new phase entry to tasks/PHASES.md with:
   - Phase number and a clear, short name derived from the narrative
   - Status: queued
   - Scope section: 2–4 sentences capturing the phase goal in concrete terms
   - A list of the task IDs you will create (fill this in after you know the IDs)
6. Create task stub files in tasks/backlog/ for each distinct piece of work you identify in the narrative. For each stub:
   - Assign the next available T-NNN ID
   - Use the project's task-template.md format
   - Fill in the title, phase_num header (linking it to the new phase), and the "## What" section with 2–3 sentences from the narrative context
   - Leave acceptance criteria as stubs (checkboxes with placeholders) — the user will flesh those out or run /spec on them later
   - Mark is_stub: true in frontmatter if the project uses that convention
7. Stage and commit everything in one commit: "plan: Phase N — [name] ([X] tasks)"
8. Do NOT push and do NOT ask about PR creation — a PR will be opened automatically for review upon completion. This is mandatory and requires no action from you.

Be liberal in breaking the narrative into tasks — one concrete deliverable per task. If the narrative describes 6 things, create 6 tasks. Don't bundle unrelated work.

Start now.`;
}

/* ------------------------------------------------------------------ */
/* Task number scanner (used by prompts for context, not file creation) */
/* ------------------------------------------------------------------ */

/** Scan tasks/{backlog,active,done} and return the next unused T-NNN number.
 *  Used when building context strings, not for direct file writes. */
export function nextTaskNumber(repoPath: string): number {
  const states = ['backlog', 'active', 'done'] as const;
  let max = 0;
  for (const state of states) {
    const dir = path.join(repoPath, 'tasks', state);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^T-(\d+)/i);
      if (m?.[1]) max = Math.max(max, parseInt(m[1], 10));
    }
  }
  return max + 1;
}

