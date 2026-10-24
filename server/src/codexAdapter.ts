import { spawn, execSync, type ChildProcess } from 'node:child_process';
import type { AgentEvent } from '../../shared/types.ts';
import type { AgentAdapter, RunContext, RunResult } from './adapter.ts';

type EventSink = (e: Omit<AgentEvent, 'id' | 'taskId'>) => void;

interface CodexItem {
  id?: string;
  type?: string;
  text?: string;
  command?: string;
  status?: string;
  exit_code?: number;
  aggregated_output?: string;
  changes?: { path?: string; kind?: string }[];
}

function shortPath(p: string, projectDir?: string) {
  const rel = projectDir && p.startsWith(projectDir) ? p.slice(projectDir.length + 1) : p;
  return rel.split('/').slice(-2).join('/');
}

interface CodexEvent {
  type: string;
  thread_id?: string;
  item?: CodexItem;
  usage?: unknown;
  error?: { message?: string };
  message?: string;
}

const SECRET_PATTERNS = [/sk-[A-Za-z0-9_-]{16,}/g, /AIza[0-9A-Za-z_-]{30,}/g, /xi-api-key[^\s]*/gi, /Bearer\s+[A-Za-z0-9._-]{16,}/g];

export function redact(text: string): string {
  return SECRET_PATTERNS.reduce((t, re) => t.replace(re, '[redacted]'), text);
}

function descendants(root: number): number[] {
  let rows: number[][];
  try {
    rows = execSync('ps -axo pid=,ppid=').toString().trim().split('\n').map(l => l.trim().split(/\s+/).map(Number));
  } catch {
    return [];
  }
  const out: number[] = [];
  const stack = [root];
  while (stack.length) {
    const p = stack.pop()!;
    for (const [pid, ppid] of rows) if (ppid === p) { out.push(pid); stack.push(pid); }
  }
  return out;
}

function killTree(child: ChildProcess) {
  if (!child.pid) return;
  const kids = descendants(child.pid);
  for (const pid of kids.reverse()) { try { process.kill(pid, 'SIGTERM'); } catch {} }
  try { process.kill(-child.pid, 'SIGTERM'); } catch {}
  setTimeout(() => {
    for (const pid of [child.pid!, ...kids]) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }, 3000);
}

function summarize(ev: CodexEvent, projectDir?: string): string {
  const it = ev.item;
  switch (ev.type) {
    case 'thread.started': return `thread ${ev.thread_id}`;
    case 'turn.started': return 'turn started';
    case 'turn.completed': return 'turn completed';
    case 'turn.failed': return `turn failed: ${ev.error?.message ?? ''}`;
    case 'error': return `error: ${ev.message ?? ''}`;
    case 'item.started':
    case 'item.completed': {
      if (!it) return ev.type;
      if (it.type === 'command_execution') {
        const cmd = (it.command ?? '').replace(/^\/bin\/zsh -lc\s*/, '').replace(/^['"]|['"]$/g, '').slice(0, 120);
        if (ev.type === 'item.started') return `$ ${cmd}`;
        const failed = (it.exit_code ?? 0) !== 0;
        const tail = failed ? ` :: ${(it.aggregated_output ?? '').trim().split('\n').slice(-3).join(' | ').slice(0, 200)}` : '';
        return `$ ${cmd} → exit ${it.exit_code ?? '?'}${tail}`;
      }
      if (it.type === 'agent_message') return (it.text ?? '').slice(0, 300);
      if (it.type === 'reasoning') return (it.text ?? '').slice(0, 160);
      if (it.type === 'file_change') return `${ev.type === 'item.started' ? 'editing' : 'edited'} ${(it.changes ?? []).map(c => `${shortPath(c.path ?? '', projectDir)}${c.kind && c.kind !== 'update' ? ` (${c.kind})` : ''}`).join(', ')}`;
      return it.type ?? ev.type;
    }
    default: return ev.type;
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly name = 'codex';
  private active: ChildProcess | null = null;
  private stopping = false;

  constructor(private model?: string) {}

  private spawnCodex(args: string[], projectDir: string) {
    const base = ['-C', projectDir, '-c', 'sandbox_workspace_write.network_access=true'];
    if (this.model) base.push('-m', this.model);
    return spawn('codex', [...base, ...args], { detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } });
  }

  private readLines(child: ChildProcess, onLine: (line: string) => void, onStderr: (s: string) => void) {
    let buf = '';
    child.stdout!.on('data', d => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    child.stdout!.on('end', () => { if (buf.trim()) onLine(buf.trim()); });
    child.stderr!.on('data', d => onStderr(String(d)));
  }

  async run(prompt: string, ctx: RunContext, onEvent: EventSink): Promise<RunResult> {
    this.stopping = false;
    const args = ['--sandbox', 'workspace-write', 'exec', '--json', '--skip-git-repo-check'];
    if (ctx.threadId) args.push('resume', ctx.threadId);
    args.push(prompt);
    const child = this.spawnCodex(args, ctx.projectDir);
    this.active = child;

    let threadId = ctx.threadId;
    let lastMessage = '';
    let commandsRun = 0;
    let commandsFailed = 0;
    let completed = false;
    let stderr = '';
    const files = new Set<string>();
    let lastExitCode: number | null = null;

    this.readLines(child, line => {
      let ev: CodexEvent;
      try { ev = JSON.parse(line); } catch { onEvent({ ts: Date.now(), type: 'raw', summary: redact(line.slice(0, 200)) }); return; }
      if (ev.type === 'thread.started' && ev.thread_id) threadId = ev.thread_id;
      if (ev.type === 'turn.completed') completed = true;
      if (ev.type === 'item.completed' && ev.item?.type === 'command_execution') {
        commandsRun++;
        lastExitCode = ev.item.exit_code ?? null;
        if ((ev.item.exit_code ?? 0) !== 0) commandsFailed++;
      }
      if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') lastMessage = ev.item.text ?? '';
      if (ev.type === 'item.completed' && ev.item?.type === 'file_change') for (const c of ev.item.changes ?? []) if (c.path) files.add(shortPath(c.path, ctx.projectDir));
      const type = ev.item?.type ? `${ev.type}:${ev.item.type}` : ev.type;
      onEvent({ ts: Date.now(), type, summary: redact(summarize(ev, ctx.projectDir)), raw: ev });
    }, s => { stderr += s; });

    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(resolve => {
      child.on('exit', (code, signal) => resolve({ code, signal }));
      child.on('error', err => { stderr += err.message; resolve({ code: -1, signal: null }); });
    });
    this.active = null;

    const relevantErr = stderr.split('\n').filter(l => l && !l.includes('Reading additional input')).join('\n').trim();
    if (relevantErr) onEvent({ ts: Date.now(), type: 'stderr', summary: redact(relevantErr.slice(0, 300)) });

    if (this.stopping) {
      return { threadId, summary: 'Interrupted by user', commandsRun, commandsFailed, files: [...files], lastExitCode, completed: false };
    }
    if (!completed && exit.code !== 0) {
      throw new Error(`codex exited with code ${exit.code}${relevantErr ? `: ${relevantErr.slice(0, 200)}` : ''}`);
    }
    return { threadId, summary: redact(lastMessage || 'Turn completed without a final message'), commandsRun, commandsFailed, files: [...files], lastExitCode, completed };
  }

  async stop(): Promise<void> {
    const child = this.active;
    if (!child) return;
    this.stopping = true;
    killTree(child);
    await new Promise<void>(resolve => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', () => resolve());
      setTimeout(resolve, 6000);
    });
  }

  async research(question: string, projectDir: string): Promise<string> {
    const args = ['--sandbox', 'read-only', 'exec', '--ephemeral', '--json', '--skip-git-repo-check',
      `Answer concisely (2-4 sentences, spoken aloud to a developer) based only on reading the project. Do not modify anything. Question: ${question}`];
    const child = this.spawnCodex(args, projectDir);
    let answer = '';
    let stderr = '';
    this.readLines(child, line => {
      try {
        const ev: CodexEvent = JSON.parse(line);
        if (ev.type === 'item.completed' && ev.item?.type === 'agent_message') answer = ev.item.text ?? answer;
      } catch {}
    }, s => { stderr += s; });
    const code = await new Promise<number | null>(resolve => child.on('exit', c => resolve(c)));
    if (!answer) throw new Error(`research failed (exit ${code}): ${redact(stderr.slice(0, 200))}`);
    return redact(answer);
  }
}
