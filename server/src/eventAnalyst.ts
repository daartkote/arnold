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
- SPEAK: a milestone the engineer wants to hear while it happens: Codex announced its plan or approach; it edited files (say which and what for); it started or finished a build/test run (with exit code); a command failed in a blocking way; it asks a question; the task finished.
"speech" is 1-3 spoken sentences in the voice of a senior engineer narrating their own work: concrete file names, components, types, commands, exit codes. No markdown. Never say a build or tests passed unless an exit code 0 for that exact command is in the events. For a finished task, summarize what changed, in which files, and what was verified.`;

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
    const outcome = finished
      ? `\nTASK FINISHED with status "${finished.status}". Files changed: ${finished.files?.join(', ') || 'none recorded'}. Commands run: ${finished.commandsRun ?? 0}, failed: ${finished.commandsFailed ?? 0}. Agent's final message: ${(finished.summary ?? '').slice(0, 900)}`
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
