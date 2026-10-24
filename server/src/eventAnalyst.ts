import type { AgentEvent, Task } from '../../shared/types.ts';
import { llm as gemma, parseJsonObject } from './llm.ts';
import type { Orchestrator } from './orchestrator.ts';

interface Verdict {
  decision: 'SKIP' | 'REMEMBER' | 'SPEAK';
  note?: string;
  speech?: string;
}

const RULES = `You watch raw events from a coding agent (Codex) working on a software project and decide what the developer, a software engineer listening over a headset, should hear right now.
Respond ONLY with JSON: {"decision":"SKIP"|"REMEMBER"|"SPEAK","note":string,"speech":string}
- SKIP: pure noise (listing directories, grepping, re-reading files, a command that only inspects state).
- REMEMBER: a fact worth keeping for later questions (a design decision, a data format, a limitation, a file that now owns some logic). "note" is one technical sentence.
- SPEAK: a milestone the engineer wants to hear while it happens: Codex announced its plan or approach (once, at the start); it edited files (say which and what for); a build or test command FAILED (quote the command and the error line); it asks a question; the task finished.
Do not SPEAK for successful verification commands (build or tests passing) in the middle of a task; the final report covers that. Exploration commands that exit non-zero (rg, grep, ls, cat finding nothing) are not failures, ignore them.
"speech" is 1-2 spoken sentences in the voice of a senior engineer narrating their own work: concrete file names, components, types, commands, exit codes. No markdown, no filler, no "all set" or "ready to test". Say "build passed" only if npm run build (or equivalent) exited 0 in the events; say "tests" only if a test command ran. For a finished task: what changed, in which files, and what was verified, in at most two sentences.`;

export class EventAnalyst {
  private buffer: AgentEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastSpokeAt = new Map<string, number>();
  readonly memory: string[] = [];
  static readonly COOLDOWN_MS = 25000;

  constructor(private orchestrator: Orchestrator) {
    orchestrator.on('event', (e: AgentEvent) => this.onEvent(e));
    orchestrator.on('taskFinished', (t: Task) => void this.onTaskFinished(t));
  }

  private onEvent(e: AgentEvent) {
    if (e.type.endsWith(':reasoning')) return;
    this.buffer.push(e);
    if (this.buffer.length >= 6) void this.flush('batch');
    else if (!this.timer) this.timer = setTimeout(() => void this.flush('timer'), 8000);
  }

  private async onTaskFinished(task: Task) {
    await this.flush('final', task);
  }

  private async flush(reason: string, finished?: Task) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!finished && this.buffer.some(e => e.type === 'turn.completed' || e.type === 'turn.failed')) return;
    const batch = this.buffer.splice(0);
    if (!batch.length && !finished) return;
    const taskId = finished?.id ?? batch[0]?.taskId;
    if (!taskId) return;
    const taskText = finished?.text ?? this.orchestrator.getState().tasks.find(t => t.id === taskId)?.text ?? '';
    const lines = batch.map(e => `${e.type}: ${e.summary}`).join('\n');
    const allEvents = this.orchestrator.getState().events.filter(e => e.taskId === taskId);
    const commands = allEvents.filter(e => e.type === 'item.completed:command_execution').map(e => e.summary.replace(/^\$ /, ''));
    const testRan = commands.some(c => /\b(test|vitest|jest|pytest|mocha|playwright|cypress)\b/i.test(c));
    const buildRan = commands.filter(c => /\b(build|tsc|compile)\b/i.test(c));
    const facts = finished
      ? `\nVERIFICATION FACTS (authoritative):\n  build commands: ${buildRan.length ? buildRan.map(c => c.slice(0, 120)).join('; ') : 'none ran'}\n  test command ran: ${testRan ? 'yes' : 'NO, do not mention tests'}`
      : '';
    const outcome = finished
      ? `\nTASK FINISHED with status "${finished.status}". Files changed: ${finished.files?.join(', ') || 'none recorded'}. Commands run: ${finished.commandsRun ?? 0}, failed: ${finished.commandsFailed ?? 0}. Agent's final message: ${(finished.summary ?? '').slice(0, 900)}${facts}`
      : '';
    const prompt = `${RULES}\n\nTask: ${taskText}\nEvents:\n${lines || '(none)'}${outcome}\n\nJSON only.`;
    try {
      const { text, ms } = await gemma(prompt, { json: true, maxTokens: 250 });
      const v = parseJsonObject<Verdict>(text);
      if (!v) return;
      console.log(`[analyst] ${reason} ${ms}ms -> ${v.decision}${v.note ? ` (${v.note.slice(0, 80)})` : ''}`);
      this.orchestrator.transcript('analyst', `${v.decision}${v.note ? `: ${v.note}` : ''}`, { reason, events: batch.length, ms, speech: v.speech });
      if (v.decision === 'REMEMBER' && v.note) this.memory.push(v.note);
      const hasFailure = batch.some(e => {
        const item = (e.raw as { item?: { exit_code?: number } } | undefined)?.item;
        return typeof item?.exit_code === 'number' && item.exit_code !== 0;
      });
      if (v.decision === 'SPEAK' && v.speech && !testRan) {
        v.speech = v.speech.replace(/\b(,?\s*and\s+)?(unit\s+|all\s+)?tests?\s+(all\s+)?(passed|pass|succeeded|succeed|are\s+green|green)\b/gi, '').replace(/\bbuild and tests\b/gi, 'build').replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').trim();
      }
      if (v.decision === 'SPEAK' && v.speech) {
        const since = Date.now() - (this.lastSpokeAt.get(taskId) ?? 0);
        if (!finished && !hasFailure && since < EventAnalyst.COOLDOWN_MS) {
          if (v.note) this.memory.push(v.note);
          return;
        }
        this.lastSpokeAt.set(taskId, Date.now());
        this.orchestrator.notify(taskId, v.speech);
      }
      if (finished && finished.status !== 'done' && v.decision !== 'SPEAK') {
        this.orchestrator.notify(taskId, `The task "${taskText.slice(0, 60)}" ended with status ${finished.status}.`);
      }
    } catch (err) {
      console.log('[analyst] error', (err as Error).message);
    }
  }
}
