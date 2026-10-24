import type { AgentEvent, Task } from '../../shared/types.ts';
import { gemma, parseJsonObject } from './gemma.ts';
import type { Orchestrator } from './orchestrator.ts';

interface Verdict {
  decision: 'SKIP' | 'REMEMBER' | 'SPEAK';
  note?: string;
  speech?: string;
}

const RULES = `You review a batch of raw events from a coding agent working on a developer's project and decide what the developer, who is listening over a headset, should hear.
Respond ONLY with JSON: {"decision":"SKIP"|"REMEMBER"|"SPEAK","note":string,"speech":string}
- SKIP: routine progress (reading files, reasoning, successful intermediate commands). Most batches are SKIP.
- REMEMBER: a fact worth keeping for later questions (a design decision, a file that was created, a limitation). Put it in "note", one sentence.
- SPEAK: only for things the developer needs now: the task finished (say what was done and whether build/tests actually ran and their exit codes), a command failed in a way that blocks progress, or the agent is asking a question. "speech" is 1-2 spoken sentences, factual, no markdown. Never say tests or build passed unless an exit code 0 for that command is in the events.`;

export class EventAnalyst {
  private buffer: AgentEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private spokenFor = new Set<string>();
  readonly memory: string[] = [];

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
      ? `\nTASK FINISHED with status "${finished.status}". Commands run: ${finished.commandsRun ?? 0}, failed: ${finished.commandsFailed ?? 0}. Agent's final message: ${finished.summary ?? ''}`
      : '';
    const prompt = `${RULES}\n\nTask: ${taskText}\nEvents:\n${lines || '(none)'}${outcome}\n\nJSON only.`;
    try {
      const { text, ms } = await gemma(prompt, { json: true, maxTokens: 250 });
      const v = parseJsonObject<Verdict>(text);
      if (!v) return;
      console.log(`[analyst] ${reason} ${ms}ms -> ${v.decision}${v.note ? ` (${v.note.slice(0, 80)})` : ''}`);
      if (v.decision === 'REMEMBER' && v.note) this.memory.push(v.note);
      const hasFailure = batch.some(e => {
        const item = (e.raw as { item?: { exit_code?: number } } | undefined)?.item;
        return typeof item?.exit_code === 'number' && item.exit_code !== 0;
      });
      if (v.decision === 'SPEAK' && v.speech) {
        if (!finished && (!hasFailure || this.spokenFor.has(taskId))) {
          if (v.note) this.memory.push(v.note);
          return;
        }
        this.spokenFor.add(taskId);
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
