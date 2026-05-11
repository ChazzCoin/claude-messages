// Repo monitor — reads claude-kit structured files from a local repo
// and returns a typed snapshot. Pure read + parse, no side effects.
//
// claude-kit structure (consistent across all repos):
//   CLAUDE.md                  project name, stack, description
//   .claude/foundation.json    repo URL, pinned SHA
//   tasks/PHASES.md            phase names + status emoji
//   tasks/ROADMAP.md           phase → task membership
//   tasks/backlog/TASK-NNN-*.md
//   tasks/active/TASK-NNN-*.md
//   tasks/done/TASK-NNN-*.md
//   tasks/AUDIT.md             dated activity log

import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export interface RepoMeta {
  name: string;
  description: string | null;
  platform: string | null;    // ios | web | python | etc
  tech_stack: string | null;  // raw first-paragraph from CLAUDE.md tech section
  repo_url: string | null;    // from .claude/foundation.json
  pinned_sha: string | null;
}

export type PhaseStatus = 'queued' | 'active' | 'shipped' | 'unknown';
export type TaskState = 'backlog' | 'active' | 'done';

export interface RepoPhase {
  phase_num: number;
  name: string;
  status: PhaseStatus;
  scope: string | null;
  task_ids: string[];         // TASK-NNN strings belonging to this phase
}

export interface RepoTask {
  task_id: string;            // "TASK-018" or "TASK-018a"
  title: string;
  state: TaskState;
  phase_num: number | null;   // null = cross-cutting or unassigned
  is_stub: boolean;
  body: string;               // raw markdown
  file_path: string;          // absolute path
  mtime: number;              // unix ms — when the file last changed
}

export interface AuditEntry {
  entry_date: string;         // YYYY-MM-DD
  emoji: string;
  text: string;
}

export interface RepoSnapshot {
  meta: RepoMeta;
  phases: RepoPhase[];
  tasks: RepoTask[];
  audit_entries: AuditEntry[];
  /** Unix ms when this snapshot was taken. */
  snapshot_at: number;
  /** Latest git commit SHA in this repo (best-effort). */
  latest_commit_sha: string | null;
  /** Human-readable summary of latest commit. */
  latest_commit_message: string | null;
}

/* ------------------------------------------------------------------ */
/* main extractor                                                       */
/* ------------------------------------------------------------------ */

export async function extractRepo(repoPath: string): Promise<RepoSnapshot> {
  const meta = readMeta(repoPath);
  const phases = readPhases(repoPath);
  const roadmapPhaseTaskIds = readRoadmapTaskIds(repoPath);

  // Merge roadmap task membership into phases.
  for (const phase of phases) {
    phase.task_ids = roadmapPhaseTaskIds[phase.phase_num] ?? [];
  }

  const tasks = readTasks(repoPath, roadmapPhaseTaskIds);
  const audit_entries = readAuditLog(repoPath);
  const { sha, message } = await getLatestCommit(repoPath);

  return {
    meta,
    phases,
    tasks,
    audit_entries,
    snapshot_at: Date.now(),
    latest_commit_sha: sha,
    latest_commit_message: message,
  };
}

/* ------------------------------------------------------------------ */
/* meta (CLAUDE.md + foundation.json)                                  */
/* ------------------------------------------------------------------ */

function readMeta(repoPath: string): RepoMeta {
  let name = path.basename(repoPath);
  let description: string | null = null;
  let platform: string | null = null;
  let techStack: string | null = null;
  let repoUrl: string | null = null;
  let pinnedSha: string | null = null;

  // CLAUDE.md — project name from "What this is" section or first H1.
  const claudeMd = readFile(path.join(repoPath, 'CLAUDE.md'));
  if (claudeMd) {
    // Name: first ## heading that contains "What this is" or first H1 after it
    const whatMatch = claudeMd.match(/##\s+What this is\s*\n+([\s\S]*?)(?=\n##|\n#|$)/i);
    if (whatMatch) {
      const body = whatMatch[1]!.trim();
      // First sentence or backtick-quoted name
      const nameMatch = body.match(/`([^`]+)`/) ?? body.match(/^([^\n.–—]+)/);
      if (nameMatch) name = (nameMatch[1] ?? name).trim().slice(0, 60);
      description = body.split('\n')[0]?.trim() ?? null;
    }

    // Platform
    const platformMatch = claudeMd.match(/\*\*Platform[^*]*\*\*[:\s]+([^\n*]+)/i);
    if (platformMatch) platform = platformMatch[1]!.trim().slice(0, 40);

    // Tech stack — first value after "**Runtime**" or "**Language**"
    const stackMatch = claudeMd.match(/##\s+Tech stack[\s\S]{0,1200}?(?=\n##|$)/i);
    if (stackMatch) {
      const runtimeLine = stackMatch[0].match(/\*\*Runtime[^*]*\*\*[:\s]+([^\n]+)/i);
      const langLine    = stackMatch[0].match(/\*\*Language[^*]*\*\*[:\s]+([^\n]+)/i);
      const frameLine   = stackMatch[0].match(/\*\*Framework[^*]*\*\*[:\s]+([^\n]+)/i);
      const picks = [runtimeLine, langLine, frameLine]
        .filter(Boolean)
        .map((m) => m![1]!.trim().replace(/\s+/g, ' '));
      techStack = picks.slice(0, 2).join(' · ') || null;
    }
  }

  // .claude/foundation.json
  const foundationRaw = readFile(path.join(repoPath, '.claude', 'foundation.json'));
  if (foundationRaw) {
    try {
      const f = JSON.parse(foundationRaw) as Record<string, unknown>;
      repoUrl = (f.kit as Record<string, unknown>)?.repo as string ?? null;
      pinnedSha = f.pinned_sha as string ?? null;
    } catch { /* malformed — skip */ }
  }

  return { name, description, platform, tech_stack: techStack, repo_url: repoUrl, pinned_sha: pinnedSha };
}

/* ------------------------------------------------------------------ */
/* phases (tasks/PHASES.md)                                            */
/* ------------------------------------------------------------------ */

const PHASE_EMOJI_MAP: Record<string, PhaseStatus> = {
  '📋': 'queued',
  '🚧': 'active',
  '✅': 'shipped',
};

function readPhases(repoPath: string): RepoPhase[] {
  const src = readFile(path.join(repoPath, 'tasks', 'PHASES.md'));
  if (!src) return [];

  const phases: RepoPhase[] = [];
  // Match "## Phase N — Name" headings
  const headingRe = /^##\s+Phase\s+(\d+)\s*[—\-–]\s*(.+)$/gm;
  let m: RegExpExecArray | null;
  const headingPositions: Array<{ phaseNum: number; name: string; start: number }> = [];

  while ((m = headingRe.exec(src)) !== null) {
    headingPositions.push({ phaseNum: parseInt(m[1]!), name: m[2]!.trim(), start: m.index });
  }

  for (let i = 0; i < headingPositions.length; i++) {
    const { phaseNum, name, start } = headingPositions[i]!;
    const end = headingPositions[i + 1]?.start ?? src.length;
    const body = src.slice(start, end);

    // Status line: "**Status:** 📋 Queued" etc
    let status: PhaseStatus = 'unknown';
    const statusMatch = body.match(/\*\*Status[^*]*\*\*[:\s]+([📋🚧✅])/u);
    if (statusMatch) {
      status = PHASE_EMOJI_MAP[statusMatch[1]!] ?? 'unknown';
    }

    // Scope — first paragraph after **Scope.**
    let scope: string | null = null;
    const scopeMatch = body.match(/\*\*Scope[^*]*\*\*[.:\s]+([\s\S]*?)(?=\n\n|\n##|$)/i);
    if (scopeMatch) scope = scopeMatch[1]!.replace(/\s+/g, ' ').trim().slice(0, 300) || null;

    phases.push({ phase_num: phaseNum, name, status, scope, task_ids: [] });
  }

  return phases;
}

/* ------------------------------------------------------------------ */
/* roadmap (tasks/ROADMAP.md) — returns phase_num → task_id[]         */
/* ------------------------------------------------------------------ */

function readRoadmapTaskIds(repoPath: string): Record<number, string[]> {
  const src = readFile(path.join(repoPath, 'tasks', 'ROADMAP.md'));
  if (!src) return {};

  const result: Record<number, string[]> = {};
  let currentPhase: number | null = null;

  for (const line of src.split('\n')) {
    const phaseMatch = line.match(/^##\s+Phase\s+(\d+)/i);
    if (phaseMatch) {
      currentPhase = parseInt(phaseMatch[1]!);
      result[currentPhase] = result[currentPhase] ?? [];
      continue;
    }
    // Task line: "- TASK-018 — Title" or "- TASK-018a — Title"
    const taskMatch = line.match(/^\s*[-*]\s+(TASK-\d{3}[a-z]?)\b/i);
    if (taskMatch && currentPhase !== null) {
      result[currentPhase]!.push(taskMatch[1]!.toUpperCase());
    }
  }

  return result;
}

/* ------------------------------------------------------------------ */
/* tasks (tasks/backlog|active|done/*.md)                              */
/* ------------------------------------------------------------------ */

function readTasks(
  repoPath: string,
  roadmapTaskIds: Record<number, string[]>,
): RepoTask[] {
  // Invert roadmap map: TASK-NNN → phase_num
  const taskPhaseMap: Record<string, number> = {};
  for (const [phase, ids] of Object.entries(roadmapTaskIds)) {
    for (const id of ids) taskPhaseMap[id] = parseInt(phase);
  }

  const tasks: RepoTask[] = [];
  const tasksDir = path.join(repoPath, 'tasks');

  for (const state of ['backlog', 'active', 'done'] as TaskState[]) {
    const dir = path.join(tasksDir, state);
    if (!fs.existsSync(dir)) continue;

    for (const filename of fs.readdirSync(dir)) {
      if (!filename.endsWith('.md')) continue;
      // Filename: TASK-018-some-slug.md  or  TASK-018a-some-slug.md
      const idMatch = filename.match(/^(TASK-\d{3}[a-z]?)/i);
      if (!idMatch) continue;

      const taskId = idMatch[1]!.toUpperCase();
      const filePath = path.join(dir, filename);
      const body = readFile(filePath) ?? '';

      // Title: first H1 line, strip "TASK-NNN: " prefix
      const titleMatch = body.match(/^#\s+(?:TASK-\d{3}[a-z]?:\s*)?(.+)$/im);
      const title = titleMatch ? titleMatch[1]!.trim() : filename.replace(/\.md$/, '');

      const isStub = body.includes('STATUS: STUB');

      let mtime = 0;
      try { mtime = fs.statSync(filePath).mtimeMs; } catch { /* skip */ }

      tasks.push({
        task_id: taskId,
        title,
        state,
        phase_num: taskPhaseMap[taskId] ?? null,
        is_stub: isStub,
        body,
        file_path: filePath,
        mtime,
      });
    }
  }

  // Sort: active first, then backlog, then done; within each by task_id
  const stateOrder = { active: 0, backlog: 1, done: 2 };
  tasks.sort((a, b) =>
    (stateOrder[a.state] - stateOrder[b.state]) ||
    a.task_id.localeCompare(b.task_id),
  );

  return tasks;
}

/* ------------------------------------------------------------------ */
/* audit log (tasks/AUDIT.md)                                          */
/* ------------------------------------------------------------------ */

const AUDIT_EMOJIS = ['🚀', '📦', '📜', '🏗', '🔥', '⚠️', '✅', '🧪', '🐛'];

function readAuditLog(repoPath: string): AuditEntry[] {
  const src = readFile(path.join(repoPath, 'tasks', 'AUDIT.md'));
  if (!src) return [];

  const entries: AuditEntry[] = [];
  let currentDate: string | null = null;

  for (const line of src.split('\n')) {
    const dateMatch = line.match(/^##\s+(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) { currentDate = dateMatch[1]!; continue; }
    if (!currentDate) continue;

    const bulletMatch = line.match(/^\s*[-*]\s+(.+)/);
    if (!bulletMatch) continue;

    const text = bulletMatch[1]!.trim();
    const emojiMatch = text.match(
      new RegExp(`^(${AUDIT_EMOJIS.map((e) => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s*`),
    );
    const emoji = emojiMatch ? emojiMatch[1]! : '·';
    const cleanText = text.replace(/^[🚀📦📜🏗🔥⚠✅🧪🐛️]+\s*\*\*/, '').replace(/\*\*/, '').trim();

    entries.push({ entry_date: currentDate, emoji, text: cleanText.slice(0, 300) });
  }

  // Return newest-first, cap at 50
  return entries.slice(0, 50);
}

/* ------------------------------------------------------------------ */
/* git                                                                  */
/* ------------------------------------------------------------------ */

async function getLatestCommit(
  repoPath: string,
): Promise<{ sha: string | null; message: string | null }> {
  try {
    const { stdout } = await execFileP(
      'git',
      ['log', '-1', '--format=%H\t%s'],
      { cwd: repoPath, timeout: 5_000 },
    );
    const [sha, ...rest] = stdout.trim().split('\t');
    return { sha: sha || null, message: rest.join('\t').trim() || null };
  } catch {
    return { sha: null, message: null };
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function readFile(filePath: string): string | null {
  try { return fs.readFileSync(filePath, 'utf8'); } catch { return null; }
}

/** Quick check: does this path look like a claude-kit repo? */
export function isClaudeKitRepo(repoPath: string): boolean {
  return (
    fs.existsSync(path.join(repoPath, '.claude', 'foundation.json')) ||
    fs.existsSync(path.join(repoPath, 'tasks', 'ROADMAP.md'))
  );
}

/** Compute how many days a task file's mtime is behind now. */
export function daysStale(mtimeMs: number): number {
  return Math.floor((Date.now() - mtimeMs) / (1000 * 60 * 60 * 24));
}
