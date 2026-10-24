import type { AgentEvent, Task } from '../../shared/types.ts';
import { llm as gemma, parseJsonObject } from './llm.ts';
import type { Orchestrator } from './orchestrator.ts';
import { batchHasVerificationFailure, batchWritesFiles, describeVerification, filesWrittenIn } from './verification.ts';

interface Verdict {
  decision: 'SKIP' | 'REMEMBER' | 'SPEAK';
  note?: string;
  speech?: string;
  claims?: { build_passed?: boolean; tests_passed?: boolean };
}

const RULES = `You watch raw events from a coding agent (Codex) working on a software project and decide what the developer, a software engineer listening over a headset, should hear right now.
Respond ONLY with JSON: {"decision":"SKIP"|"REMEMBER"|"SPEAK","note":string,"speech":string,"claims":{"build_passed":boolean,"tests_passed":boolean}}
"claims" must state exactly what your speech asserts: build_passed true only if the speech says or implies the build succeeded; tests_passed likewise. They are checked against the real exit codes.
- SKIP: pure noise (listing directories, grepping, re-reading files, a command that only inspects state).
- REMEMBER: a fact worth keeping for later questions (a design decision, a data format, a limitation, a file that now owns some logic). "note" is one technical sentence about the code. Never record anything about the user's preferences or answers: you only see the agent's output, not the user.
- SPEAK: a milestone the engineer wants to hear while it happens: Codex announced its plan or approach (once, at the start); it edited files (say which and what for); a build or test command FAILED (quote the command and the error line); it asks a question; the task finished.
Do not SPEAK for successful verification commands (build or tests passing) in the middle of a task; the final report covers that. Exploration and lint-style commands that exit non-zero (rg, grep, ls, cat, find, git diff --check, git status) are not failures: ignore them completely, never mention them.
Speak in first person as the engineer doing the work ("I'm adding…", "I edited…"), never "the agent announced".
"speech" is 1-2 spoken sentences in the voice of a senior engineer narrating their own work: concrete file names, components, types, commands, exit codes. No markdown, no filler, no "all set" or "ready to test". Say "build passed" only if npm run build (or equivalent) exited 0 in the events; say "tests" only if a test command ran. For a finished task: what changed, in which files, and what was verified, in at most two sentences.`;

export class EventAnalyst {
  private buffer: AgentEvent[] = [];
  private timer: NodeJS.Timeout | null = null;
  private lastSpokeAt = new Map<string, number>();
  readonly memory: string[] = [];
  static readonly COOLDOWN_MS = 15000;

  constructor(private orchestrator: Orchestrator) {
    orchestrator.on('event', (e: AgentEvent) => this.onEvent(e));
    orchestrator.on('taskFinished', (t: Task) => void this.onTaskFinished(t));
  }

  private onEvent(e: AgentEvent) {
    if (e.type.endsWith(':reasoning')) return;
    this.buffer.push(e);
    if (this.buffer.length >= 8) void this.flush('batch');
    else if (!this.timer) this.timer = setTimeout(() => void this.flush('timer'), 12000);
  }

  private async onTaskFinished(task: Task) {
    await this.flush('final', task);
  }

  private deferred = false;

  private async flush(reason: string, finished?: Task) {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!finished && this.buffer.some(e => e.type === 'turn.completed' || e.type === 'turn.failed')) return;
    const last = this.buffer[this.buffer.length - 1];
    if (!finished && !this.deferred && last?.type === 'item.completed:agent_message') {
      this.deferred = true;
      this.timer = setTimeout(() => void this.flush('deferred'), 3000);
      return;
    }
    this.deferred = false;
    const batch = this.buffer.splice(0);
    if (!batch.length && !finished) return;
    const taskId = finished?.id ?? batch[0]?.taskId;
    if (!taskId) return;
    const taskText = finished?.text ?? this.orchestrator.getState().tasks.find(t => t.id === taskId)?.text ?? '';
    const lines = batch.map(e => `${e.type}: ${e.summary}`).join('\n');
    const wrote = batchWritesFiles(batch);
    const verification = finished?.verification;
    const facts = finished
      ? finished.status === 'waiting'
        ? `\nTHE AGENT STOPPED TO ASK THE USER A QUESTION. SPEAK: repeat the question to the user almost verbatim, one sentence of context at most, no claims about work done.`
        : `\nVERIFICATION FACTS (authoritative, computed from exit codes): ${describeVerification(verification)}. If the build was not run, say so plainly.`
      : wrote ? `\nFILES WERE MODIFIED in this batch (file_change or a command that writes files). This is a milestone: SPEAK, naming the files and what changed.` : '';
    const outcome = finished
      ? `\nTASK FINISHED with status "${finished.status}". Files changed: ${finished.files?.join(', ') || 'none recorded'}. Commands run: ${finished.commandsRun ?? 0}, failed: ${finished.commandsFailed ?? 0}. Agent's final message: ${(finished.summary ?? '').slice(0, 900)}${facts}`
      : '';
    const prompt = `${RULES}\n\nTask: ${taskText}\nEvents:\n${lines || '(none)'}${outcome}\n\nJSON only.`;
    try {
      const { text, ms } = await gemma(prompt, { json: true, maxTokens: 300 });
      let v = parseJsonObject<Verdict>(text);
      if (!v) return;
      if (finished && finished.status !== 'waiting' && v.decision === 'SPEAK' && verification) {
        const mismatch = (claimed: boolean | undefined, actual: string) => claimed === true && actual !== 'passed';
        if (mismatch(v.claims?.build_passed, verification.build) || mismatch(v.claims?.tests_passed, verification.tests)) {
          console.log(`[analyst] claim mismatch (build ${verification.build}, tests ${verification.tests}), regenerating`);
          const fix = `${prompt}\n\nYOUR PREVIOUS ANSWER claimed build_passed=${v.claims?.build_passed ?? false}, tests_passed=${v.claims?.tests_passed ?? false}, but the facts are: build ${verification.build}, tests ${verification.tests}. Rewrite the speech so it states these facts correctly (say explicitly if the build was not run), and set claims accordingly. JSON only.`;
          const retry = parseJsonObject<Verdict>((await gemma(fix, { json: true, maxTokens: 300 })).text);
          if (retry?.speech) v = retry;
        }
      }
      console.log(`[analyst] ${reason} ${ms}ms -> ${v.decision}${v.note ? ` (${v.note.slice(0, 80)})` : ''}`);
      this.orchestrator.transcript('analyst', `${v.decision}${v.note ? `: ${v.note}` : ''}`, { reason, events: batch.length, ms, speech: v.speech });
      if (v.decision === 'REMEMBER' && v.note) this.memory.push(v.note);
      const hasFailure = batchHasVerificationFailure(batch);
      if (wrote && !finished && v.decision !== 'SPEAK' && v.speech) v.decision = 'SPEAK';
      if (wrote && !finished && v.decision !== 'SPEAK') {
        v.decision = 'SPEAK';
        const files = filesWrittenIn(batch);
        v.speech = files.length ? `Editing ${files.slice(0, 4).join(', ')}.` : 'Codex is editing project files now.';
      }
      if (finished?.status === 'waiting') { v.decision = 'SPEAK'; v.speech = finished.question ?? v.speech; }

      if (v.decision === 'SPEAK' && v.speech) {
        const since = Date.now() - (this.lastSpokeAt.get(taskId) ?? 0);
        if (!finished && !hasFailure && !wrote && since < EventAnalyst.COOLDOWN_MS) {
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
