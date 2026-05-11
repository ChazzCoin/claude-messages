// Claude CLI integration — wraps the headless `claude` binary so
// Galt's chat layer can delegate to it on demand.
//
// Anatomy on this Mac:
//   ~/.claude/remote/ccd-cli/<version>            — the binary (versioned)
//   ~/.claude/sessions/<pid>.json                 — running session metadata
//   ~/.claude/projects/<encoded-cwd>/<id>.jsonl   — session transcript
//   ~/.claude/.credentials.json                   — OAuth state
//
// The CLI:
//   - `claude -p "<prompt>"` → one-shot, prints to stdout
//   - `--output-format stream-json` emits JSONL with three event kinds:
//       system   — { type:'system', subtype:'init', session_id, cwd, model, tools, ... }
//       assistant — { type:'assistant', message:{ content:[{type:'text',text}|{type:'tool_use',...}], usage, ... } }
//       result   — { type:'result', subtype, is_error, duration_ms, total_cost_usd, result, ... }
//   - `--session-id <uuid>` reuses an existing session
//   - `--resume <id>` resumes by id (interactive picker if no id)
//   - `auth status` → { loggedIn, authMethod, apiProvider }
//
// This class is intentionally infrastructure-only: every public method
// is something an OpenAI tool can call into. Phase 1 surface: version,
// auth, session listing, sync chat. Phase 2/3 add streaming + task
// management.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import readline from 'node:readline';

const execFileP = promisify(execFile);

const CCD_CLI_ROOT = path.join(os.homedir(), '.claude', 'remote', 'ccd-cli');
const SESSIONS_DIR = path.join(os.homedir(), '.claude', 'sessions');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');

/* ------------------------------------------------------------------ */
/* binary resolution                                                   */
/* ------------------------------------------------------------------ */

function semverCompare(a: string, b: string): number {
  const pa = a.split('.').map((n) => parseInt(n, 10) || 0);
  const pb = b.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const da = pa[i] ?? 0;
    const db = pb[i] ?? 0;
    if (da !== db) return da - db;
  }
  return 0;
}

/** Best-effort: env override → newest version dir under ccd-cli →
 *  bare `claude` (PATH). Cached per-process. */
let _cachedBinary: string | null = null;
function resolveClaudeBinary(): string {
  if (_cachedBinary) return _cachedBinary;
  const override = process.env.CLAUDE_CLI_PATH;
  if (override && fs.existsSync(override)) {
    _cachedBinary = override;
    return override;
  }
  if (fs.existsSync(CCD_CLI_ROOT)) {
    const candidates = fs
      .readdirSync(CCD_CLI_ROOT)
      .filter((name) => /^\d+\.\d+/.test(name))
      .sort((a, b) => semverCompare(b, a));
    if (candidates.length > 0) {
      _cachedBinary = path.join(CCD_CLI_ROOT, candidates[0]!);
      return _cachedBinary;
    }
  }
  _cachedBinary = 'claude';
  return _cachedBinary;
}

/** Encode an absolute filesystem path the way ~/.claude/projects/ does
 *  it: replace every `/` with `-`. Used to map a cwd → its session dir. */
function encodeProjectPath(absPath: string): string {
  return absPath.replace(/\//g, '-');
}

/** Reverse of encodeProjectPath — best-effort. We can't fully recover
 *  the original (a literal `-` in a directory name is indistinguishable
 *  from a `/`) but for display purposes the leading `-` → `/` swap is
 *  good enough. */
function decodeProjectPath(encoded: string): string {
  return encoded.startsWith('-') ? '/' + encoded.slice(1).replace(/-/g, '/') : encoded;
}

/* ------------------------------------------------------------------ */
/* types                                                               */
/* ------------------------------------------------------------------ */

export interface ClaudeCliInfo {
  installed: boolean;
  binary_path: string;
  version: string | null;
  /** Auth state from `claude auth status`. Null when the auth check
   *  itself failed (binary missing, etc.). */
  auth: ClaudeAuthStatus | null;
}

export interface ClaudeAuthStatus {
  loggedIn: boolean;
  authMethod: string;        // 'oauth' | 'apiKey' | 'none' | etc.
  apiProvider: string;       // 'firstParty' | 'bedrock' | 'vertex' | ...
}

export interface RunningSessionEntry {
  pid: number;
  session_id: string;
  cwd: string;
  started_at: number;        // unix ms
  version: string;
  kind: 'interactive' | 'headless' | string;
  entrypoint: string;
}

export interface SessionSummary {
  /** UUID from filename. */
  session_id: string;
  /** Absolute path of the cwd this session ran in (decoded). */
  cwd: string;
  /** Last activity — mtime of the JSONL transcript (unix ms). */
  last_active_at: number;
  /** Best-effort title from the first user message. Truncated. */
  title: string | null;
  /** Absolute path to the JSONL transcript on disk. */
  transcript_path: string;
}

export interface ChatTurnOpts {
  prompt: string;
  /** Reuse an existing session id (or omit to start a fresh one). */
  sessionId?: string;
  /** cwd Claude runs in. Affects which CLAUDE.md it picks up + which
   *  project session dir the transcript lands in. Defaults to the
   *  current process cwd. */
  workingDir?: string;
  /** Restrict Claude's tool surface. e.g. ['Read', 'WebSearch'] for
   *  read-only browse. Use `["disabled"]` (or empty string per the
   *  CLI's convention) to disable all tools. */
  allowedTools?: string[];
  /** Disallow specific tools while leaving the rest enabled. */
  disallowedTools?: string[];
  /** Cap the agent loop. */
  maxTurns?: number;
  /** Extra system prompt appended to Claude's default. */
  appendSystemPrompt?: string;
  /** Hard cap on dollars to spend on API calls. */
  maxBudgetUsd?: number;
  /** Model alias or full name. Defaults to whatever Claude picks. */
  model?: string;
  /** Effort level. */
  effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  /** Timeout in ms (defaults to 5 minutes — Claude tasks vary widely). */
  timeoutMs?: number;
}

export interface ChatToolEvent {
  kind: 'tool_use' | 'tool_result';
  name: string;
  /** Tool input (for tool_use) or result preview (for tool_result). */
  data: unknown;
}

export interface ChatTurnResult {
  /** Final reply text. */
  reply: string;
  /** Session id Claude wrote to (echoed by the system init event). */
  session_id: string;
  /** Model claude ran. */
  model: string;
  /** Total cost reported by the result event. */
  total_cost_usd: number;
  /** Duration as reported by the result event. */
  duration_ms: number;
  /** True when result.is_error or stop_reason indicates failure. */
  is_error: boolean;
  /** Number of agent turns (round-trips). */
  num_turns: number;
  /** Aggregated token usage across the turn. */
  usage: {
    input_tokens: number;
    output_tokens: number;
    cache_creation_input_tokens: number;
    cache_read_input_tokens: number;
  };
  /** Tool calls Claude made during the turn, ordered. */
  tool_calls: ChatToolEvent[];
  /** Raw final result event (kept for diagnostics; not surfaced to
   *  the model). */
  raw_result?: unknown;
}

/* ------------------------------------------------------------------ */
/* class                                                               */
/* ------------------------------------------------------------------ */

export class ClaudeCli {
  /** Path to the resolved binary. Cached after first resolution. */
  get binaryPath(): string {
    return resolveClaudeBinary();
  }

  /** Quick health check: binary on disk, version + auth state. */
  async info(): Promise<ClaudeCliInfo> {
    const binary = this.binaryPath;
    const installed =
      binary !== 'claude' /* PATH fallback */ ? fs.existsSync(binary) : true;
    let version: string | null = null;
    let auth: ClaudeAuthStatus | null = null;
    try {
      const { stdout } = await execFileP(binary, ['--version'], { timeout: 5_000 });
      // Output shape: "2.1.128 (Claude Code)\n"
      const m = stdout.match(/(\d+\.\d+\.\d+)/);
      version = m ? m[1]! : stdout.trim();
    } catch { /* installed but version probe failed → version=null */ }
    try {
      auth = await this.authStatus();
    } catch { /* leave auth=null */ }
    return { installed, binary_path: binary, version, auth };
  }

  /** Parse `claude auth status` (returns JSON). */
  async authStatus(): Promise<ClaudeAuthStatus> {
    const { stdout } = await execFileP(this.binaryPath, ['auth', 'status'], {
      timeout: 5_000,
    });
    const parsed = JSON.parse(stdout) as Partial<ClaudeAuthStatus>;
    return {
      loggedIn: !!parsed.loggedIn,
      authMethod: typeof parsed.authMethod === 'string' ? parsed.authMethod : 'unknown',
      apiProvider: typeof parsed.apiProvider === 'string' ? parsed.apiProvider : 'unknown',
    };
  }

  /** Snapshot of running Claude processes — reads
   *  ~/.claude/sessions/*.json. Each file represents one live process;
   *  the PID is the filename. */
  listRunningSessions(): RunningSessionEntry[] {
    if (!fs.existsSync(SESSIONS_DIR)) return [];
    const out: RunningSessionEntry[] = [];
    for (const name of fs.readdirSync(SESSIONS_DIR)) {
      if (!name.endsWith('.json')) continue;
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(SESSIONS_DIR, name), 'utf8')) as Record<string, unknown>;
        const pid = parseInt(name.replace('.json', ''), 10);
        if (!Number.isFinite(pid)) continue;
        out.push({
          pid,
          session_id: String(raw.sessionId ?? ''),
          cwd: String(raw.cwd ?? ''),
          started_at: typeof raw.startedAt === 'number' ? raw.startedAt : 0,
          version: String(raw.version ?? ''),
          kind: String(raw.kind ?? 'unknown'),
          entrypoint: String(raw.entrypoint ?? 'unknown'),
        });
      } catch {
        // skip malformed files
      }
    }
    // Newest first.
    out.sort((a, b) => b.started_at - a.started_at);
    return out;
  }

  /** All persisted sessions across every project Claude has touched.
   *  Sorted by last activity (transcript mtime), newest first. Capped. */
  async listRecentSessions(limit = 25): Promise<SessionSummary[]> {
    if (!fs.existsSync(PROJECTS_DIR)) return [];
    const candidates: Array<{ file: string; cwd: string; mtime: number; sessionId: string }> = [];
    for (const projectName of fs.readdirSync(PROJECTS_DIR)) {
      const projectDir = path.join(PROJECTS_DIR, projectName);
      let stat: fs.Stats;
      try { stat = fs.statSync(projectDir); } catch { continue; }
      if (!stat.isDirectory()) continue;
      const cwd = decodeProjectPath(projectName);
      let entries: string[];
      try { entries = fs.readdirSync(projectDir); } catch { continue; }
      for (const entry of entries) {
        if (!entry.endsWith('.jsonl')) continue;
        const full = path.join(projectDir, entry);
        let s: fs.Stats;
        try { s = fs.statSync(full); } catch { continue; }
        if (!s.isFile()) continue;
        candidates.push({
          file: full,
          cwd,
          mtime: s.mtimeMs,
          sessionId: entry.replace('.jsonl', ''),
        });
      }
    }
    candidates.sort((a, b) => b.mtime - a.mtime);
    const trimmed = candidates.slice(0, limit);
    return Promise.all(trimmed.map(async (c) => {
      const meta = await readSessionMeta(c.file);
      return {
        session_id: c.sessionId,
        // Prefer the accurate cwd from the transcript's system init
        // event; fall back to the (lossy) decoded project name when
        // the transcript is empty or unreadable.
        cwd: meta.cwd ?? c.cwd,
        last_active_at: Math.round(c.mtime),
        title: meta.title,
        transcript_path: c.file,
      };
    }));
  }

  /** Find sessions tied to a specific cwd. Useful when the user is
   *  asking about "what did I work on in /path/to/project". */
  async listSessionsForCwd(cwd: string, limit = 25): Promise<SessionSummary[]> {
    const all = await this.listRecentSessions(limit * 5);
    return all.filter((s) => s.cwd === cwd).slice(0, limit);
  }

  /** Run one chat turn synchronously. Returns the parsed result once
   *  Claude exits. For long ops (file-system writes, multi-step
   *  builds) the chat UX should switch to streaming — Phase 2/3.
   *
   *  NOTE on auth: when invoked from a process that itself runs inside
   *  a Claude session, OAuth/keychain auth lookups are deliberately
   *  blocked to prevent recursion. From Galt's LaunchAgent context
   *  (running as the user, no parent Claude), auth resolves normally. */
  async chat(opts: ChatTurnOpts): Promise<ChatTurnResult> {
    const args = ['-p', opts.prompt, '--output-format', 'stream-json', '--verbose'];
    if (opts.sessionId)            args.push('--session-id', opts.sessionId);
    if (opts.appendSystemPrompt)   args.push('--append-system-prompt', opts.appendSystemPrompt);
    if (opts.maxTurns != null)     args.push('--max-turns', String(opts.maxTurns));
    if (opts.maxBudgetUsd != null) args.push('--max-budget-usd', String(opts.maxBudgetUsd));
    if (opts.model)                args.push('--model', opts.model);
    if (opts.effort)               args.push('--effort', opts.effort);
    if (opts.allowedTools && opts.allowedTools.length > 0) {
      args.push('--allowedTools', opts.allowedTools.join(' '));
    }
    if (opts.disallowedTools && opts.disallowedTools.length > 0) {
      args.push('--disallowedTools', opts.disallowedTools.join(' '));
    }

    const cwd = opts.workingDir ?? process.cwd();
    const timeoutMs = opts.timeoutMs ?? 5 * 60_000;

    return new Promise((resolve, reject) => {
      const child = spawn(this.binaryPath, args, {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      const stdoutLines: string[] = [];
      let stderrBuf = '';
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* ignore */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, 2_000);
      }, timeoutMs);
      if (timer.unref) timer.unref();

      const rl = readline.createInterface({ input: child.stdout!, crlfDelay: Infinity });
      rl.on('line', (line) => { stdoutLines.push(line); });
      child.stderr!.on('data', (chunk) => { stderrBuf += String(chunk); });

      child.on('error', (err) => {
        clearTimeout(timer);
        reject(new Error(`claude spawn failed: ${err.message}`));
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (timedOut) {
          reject(new Error(`claude timed out after ${timeoutMs}ms`));
          return;
        }
        try {
          const parsed = parseStreamJsonLines(stdoutLines);
          if (!parsed.result) {
            const stderrPreview = stderrBuf.slice(0, 400);
            reject(new Error(
              `claude exited ${code} without a result event; stderr: ${stderrPreview || '(empty)'}`,
            ));
            return;
          }
          resolve(parsed);
        } catch (err) {
          reject(new Error(`claude output parse failed: ${(err as Error).message}`));
        }
      });
    });
  }
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** Read the first user message + accurate cwd from a session JSONL.
 *  The encoded-project-dir-name `/` → `-` mapping is lossy (a literal
 *  `-` in the path collides with a path separator), so we always
 *  prefer the cwd captured in the transcript's first system-init
 *  event when available.
 *
 *  Caps line scanning so we don't read huge transcripts in full. */
async function readSessionMeta(file: string): Promise<{ title: string | null; cwd: string | null }> {
  const out: { title: string | null; cwd: string | null } = { title: null, cwd: null };
  try {
    const stream = fs.createReadStream(file, { encoding: 'utf8' });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    let count = 0;
    for await (const line of rl) {
      count++;
      if (count > 200) break;
      if (out.title && out.cwd) break;
      let parsed: Record<string, unknown>;
      try { parsed = JSON.parse(line); } catch { continue; }

      // Cwd is stamped on most event types in the transcript (user,
      // assistant, attachment, system). First one we see is enough.
      if (!out.cwd && typeof parsed.cwd === 'string' && parsed.cwd) {
        out.cwd = parsed.cwd;
      }

      // Title comes from the first user message. Two shapes observed:
      //   { type: 'queue-operation', operation: 'enqueue', content: "..." }
      //   { type: 'user', message: { content: "..." | [{type:'text',text}] } }
      if (!out.title && parsed.type === 'queue-operation' && typeof parsed.content === 'string') {
        out.title = truncateTitle(parsed.content);
        continue;
      }
      if (!out.title && parsed.type === 'user') {
        const msg = parsed.message as Record<string, unknown> | undefined;
        const content = msg?.content;
        if (typeof content === 'string') {
          out.title = truncateTitle(content);
          continue;
        }
        if (Array.isArray(content)) {
          for (const part of content) {
            if (typeof part === 'object' && part !== null && (part as Record<string, unknown>).type === 'text') {
              const text = (part as Record<string, unknown>).text;
              if (typeof text === 'string') { out.title = truncateTitle(text); break; }
            }
          }
        }
      }
    }
    rl.close();
    stream.destroy();
  } catch {
    // file unreadable / malformed → return whatever we have
  }
  return out;
}

function truncateTitle(text: string): string {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  return trimmed.length > 100 ? trimmed.slice(0, 100) + '…' : trimmed;
}

/** Parse JSONL stream-json lines emitted by `claude -p --output-format stream-json`.
 *  Aggregates assistant text, tool_use / tool_result events, and the
 *  final result. */
function parseStreamJsonLines(lines: string[]): ChatTurnResult & { result: boolean } {
  let sessionId = '';
  let model = '';
  let reply = '';
  let isError = false;
  let durationMs = 0;
  let numTurns = 0;
  let totalCost = 0;
  let resultEvent: unknown = null;
  let rawResultSeen = false;
  const usage = {
    input_tokens: 0,
    output_tokens: 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: 0,
  };
  const toolCalls: ChatToolEvent[] = [];

  for (const line of lines) {
    if (!line.trim()) continue;
    let ev: Record<string, unknown>;
    try { ev = JSON.parse(line); } catch { continue; }
    const type = ev.type;

    if (type === 'system' && ev.subtype === 'init') {
      sessionId = String(ev.session_id ?? sessionId);
      model = String(ev.model ?? model);
      continue;
    }

    if (type === 'assistant') {
      const message = ev.message as Record<string, unknown> | undefined;
      if (!message) continue;
      sessionId = String(ev.session_id ?? sessionId);
      const messageModel = message.model;
      if (typeof messageModel === 'string' && messageModel && messageModel !== '<synthetic>') model = messageModel;
      const messageUsage = message.usage as Record<string, number> | undefined;
      if (messageUsage) {
        usage.input_tokens                 += messageUsage.input_tokens                 ?? 0;
        usage.output_tokens                += messageUsage.output_tokens                ?? 0;
        usage.cache_creation_input_tokens  += messageUsage.cache_creation_input_tokens  ?? 0;
        usage.cache_read_input_tokens      += messageUsage.cache_read_input_tokens      ?? 0;
      }
      const content = message.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part !== 'object' || part === null) continue;
          const p = part as Record<string, unknown>;
          if (p.type === 'text' && typeof p.text === 'string') {
            // last text part wins as the reply — assistant may emit
            // multiple text parts when interleaved with tool calls
            reply = p.text;
          } else if (p.type === 'tool_use') {
            toolCalls.push({
              kind: 'tool_use',
              name: String(p.name ?? ''),
              data: p.input ?? null,
            });
          }
        }
      }
      continue;
    }

    if (type === 'user') {
      // tool_result messages come back as role:user in the stream
      const message = ev.message as Record<string, unknown> | undefined;
      const content = message?.content;
      if (Array.isArray(content)) {
        for (const part of content) {
          if (typeof part !== 'object' || part === null) continue;
          const p = part as Record<string, unknown>;
          if (p.type === 'tool_result') {
            toolCalls.push({
              kind: 'tool_result',
              name: String(p.tool_use_id ?? ''),  // we don't have the name here, use id
              data: p.content ?? null,
            });
          }
        }
      }
      continue;
    }

    if (type === 'result') {
      sessionId = String(ev.session_id ?? sessionId);
      isError = !!ev.is_error;
      durationMs = typeof ev.duration_ms === 'number' ? ev.duration_ms : 0;
      numTurns = typeof ev.num_turns === 'number' ? ev.num_turns : 0;
      totalCost = typeof ev.total_cost_usd === 'number' ? ev.total_cost_usd : 0;
      if (typeof ev.result === 'string' && ev.result) reply = ev.result;
      const u = ev.usage as Record<string, number> | undefined;
      if (u) {
        // result.usage is the totals; prefer it over assistant-event sums
        usage.input_tokens                 = u.input_tokens                 ?? usage.input_tokens;
        usage.output_tokens                = u.output_tokens                ?? usage.output_tokens;
        usage.cache_creation_input_tokens  = u.cache_creation_input_tokens  ?? usage.cache_creation_input_tokens;
        usage.cache_read_input_tokens      = u.cache_read_input_tokens      ?? usage.cache_read_input_tokens;
      }
      resultEvent = ev;
      rawResultSeen = true;
      continue;
    }
  }

  return {
    result: rawResultSeen,
    reply: reply.trim(),
    session_id: sessionId,
    model,
    total_cost_usd: totalCost,
    duration_ms: durationMs,
    is_error: isError,
    num_turns: numTurns,
    usage,
    tool_calls: toolCalls,
    raw_result: resultEvent,
  };
}

/* ------------------------------------------------------------------ */
/* singleton                                                           */
/* ------------------------------------------------------------------ */

/** Single instance — the class is stateless, so a singleton is fine
 *  and lets tool definitions reference it without dependency
 *  injection. */
export const claudeCli = new ClaudeCli();
