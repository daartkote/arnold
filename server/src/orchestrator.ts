import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
import { nanoid } from 'nanoid';
import type { AgentEvent, AppState, Notification, ResearchQuery, Task, TaskSource, TranscriptEntry, TranscriptKind } from '../../shared/types.ts';
import type { AgentAdapter } from './adapter.ts';
import { EventLog } from './store.ts';
import { verificationFor } from './verification.ts';

const MAX_EVENTS = 200;
const MAX_TRANSCRIPT = 300;

export class Orchestrator extends EventEmitter {
  private state: AppState;
  private log: EventLog;

  constructor(private adapter: AgentAdapter, projectDir: string, dataDir: string) {
    super();
    this.log = new EventLog(dataDir);
    this.state = {
      provider: adapter.name,
      projectDir,
      paused: false,
      activeTaskId: null,
      threadId: null,
      tasks: [],
      events: [],
      notifications: [],
      research: [],
      transcript: [],
    };
  }

  getState(): AppState {
    return this.state;
  }

  private publish() {
    this.emit('state', this.state);
  }

  transcript(kind: TranscriptKind, text: string, meta?: Record<string, unknown>): TranscriptEntry {
    const entry: TranscriptEntry = { id: nanoid(8), ts: Date.now(), kind, text, ...(meta ? { meta } : {}) };
    this.state.transcript.push(entry);
    if (this.state.transcript.length > MAX_TRANSCRIPT) this.state.transcript.splice(0, this.state.transcript.length - MAX_TRANSCRIPT);
    this.log.appendTranscript(entry);
    this.emit('transcript', entry);
    return entry;
  }

  async reset(): Promise<void> {
    if (this.activeTask()?.status === 'running') await this.stop();
    this.state.tasks = [];
    this.state.events = [];
    this.state.notifications = [];
    this.state.research = [];
    this.state.transcript = [];
    this.state.threadId = null;
    this.state.activeTaskId = null;
    this.state.paused = false;
    this.log.append({ kind: 'reset', ts: Date.now() });
    this.publish();
  }

  async resetProject(): Promise<string> {
    if (this.activeTask()?.status === 'running') await this.stop();
    const cwd = this.state.projectDir;
    const ref = process.env.PROJECT_BASELINE_REF ?? 'HEAD';
    await run('git', ['checkout', '--', '.'], { cwd });
    await run('git', ['clean', '-fdq', '-e', 'node_modules'], { cwd });
    if (ref !== 'HEAD') await run('git', ['reset', '-q', '--hard', ref], { cwd });
    this.state.threadId = null;
    this.transcript('system', `project files reset to ${ref}`);
    this.publish();
    this.emit('projectReset');
    return `project reset to ${ref}`;
  }

  unannouncedTasks(): Task[] {
    return this.state.tasks.filter(t => ['done', 'waiting', 'failed', 'interrupted'].includes(t.status) && !t.announcedAt);
  }

  markAnnounced(ids: string[]) {
    const now = Date.now();
    for (const t of this.state.tasks) if (ids.includes(t.id)) t.announcedAt = now;
    this.publish();
  }

  enqueue(text: string, source: TaskSource): Task {
    const hint = process.env.TASK_HINT ?? "When you are done, run the project's build (and tests if present) to verify, and state the exit code in your final message.";
    const task: Task = { id: nanoid(8), text: source === 'voice' && hint ? `${text}\n\n${hint}` : text, status: 'queued', source, createdAt: Date.now() };
    this.state.tasks.push(task);
    this.log.append({ kind: 'task', task });
    this.transcript('codex_prompt', text, { taskId: task.id, source });
    this.publish();
    const delay = source === 'voice' ? Number(process.env.TASK_START_DELAY_MS ?? 6000) : 0;
    if (delay > 0) setTimeout(() => void this.pump(), delay);
    else void this.pump();
    return task;
  }

  updateQueued(taskId: string, text: string): boolean {
    const task = this.state.tasks.find(t => t.id === taskId && t.status === 'queued');
    if (!task) return false;
    task.text = text;
    this.transcript('codex_prompt', text, { taskId, source: task.source, updated: true });
    this.publish();
    return true;
  }

  cancelQueued(taskId: string): boolean {
    const task = this.state.tasks.find(t => t.id === taskId && t.status === 'queued');
    if (!task) return false;
    task.status = 'cancelled';
    task.finishedAt = Date.now();
    this.publish();
    return true;
  }

  async stop(): Promise<void> {
    this.state.paused = true;
    const active = this.activeTask();
    if (active && active.status === 'running') {
      active.status = 'cancelling';
      this.publish();
      await this.adapter.stop();
    } else {
      this.publish();
    }
  }

  resume() {
    this.state.paused = false;
    this.publish();
    void this.pump();
  }

  activeTask(): Task | undefined {
    return this.state.tasks.find(t => t.id === this.state.activeTaskId);
  }

  queuedTasks(): Task[] {
    return this.state.tasks.filter(t => t.status === 'queued');
  }

  private async pump() {
    if (this.state.paused || this.state.activeTaskId) return;
    const delay = Number(process.env.TASK_START_DELAY_MS ?? 6000);
    const next = this.queuedTasks().find(t => t.source !== 'voice' || Date.now() - t.createdAt >= delay);
    if (!next) {
      const soon = this.queuedTasks()[0];
      if (soon) setTimeout(() => void this.pump(), Math.max(200, delay - (Date.now() - soon.createdAt)));
      return;
    }
    this.state.activeTaskId = next.id;
    next.status = 'running';
    next.startedAt = Date.now();
    this.publish();
    try {
      const result = await this.adapter.run(
        next.text,
        { taskId: next.id, projectDir: this.state.projectDir, threadId: this.state.threadId },
        e => this.recordEvent(next.id, e),
      );
      if (result.threadId) this.state.threadId = result.threadId;
      next.summary = result.summary;
      next.commandsRun = result.commandsRun;
      next.commandsFailed = result.commandsFailed;
      next.files = result.files;
      const verification = verificationFor(this.state.events.filter(e => e.taskId === next.id));
      next.verification = verification;
      const wasCancelling = (next.status as Task['status']) === 'cancelling';
      const asksQuestion = result.completed && result.files.length === 0 && /\?\s*$/.test(result.summary.trim());
      if (wasCancelling || !result.completed) next.status = 'interrupted';
      else if (asksQuestion) { next.status = 'waiting'; next.question = result.summary.trim(); }
      else next.status = verification.build === 'failed' || verification.tests === 'failed' ? 'failed' : 'done';
    } catch (err) {
      next.status = (next.status as Task['status']) === 'cancelling' ? 'interrupted' : 'failed';
      next.summary = err instanceof Error ? err.message : String(err);
    }
    next.finishedAt = Date.now();
    this.state.activeTaskId = null;
    this.log.append({ kind: 'task', task: next });
    this.emit('taskFinished', next);
    this.publish();
    void this.pump();
  }

  private recordEvent(taskId: string, e: Omit<AgentEvent, 'id' | 'taskId'>) {
    const event: AgentEvent = { id: nanoid(8), taskId, ...e };
    this.state.events.push(event);
    if (this.state.events.length > MAX_EVENTS) this.state.events.splice(0, this.state.events.length - MAX_EVENTS);
    this.log.append({ kind: 'event', event });
    this.emit('event', event);
  }

  notify(taskId: string, text: string): Notification {
    const notification: Notification = { id: nanoid(8), taskId, ts: Date.now(), text };
    this.state.notifications.push(notification);
    this.transcript('notification', text, { taskId });
    this.emit('notification', notification);
    this.publish();
    return notification;
  }

  ackNotification(id: string) {
    this.state.notifications = this.state.notifications.filter(n => n.id !== id);
    this.publish();
  }

  async research(question: string): Promise<ResearchQuery> {
    const q: ResearchQuery = { id: nanoid(8), question, status: 'running', createdAt: Date.now() };
    this.state.research.push(q);
    this.publish();
    try {
      q.answer = await this.adapter.research(question, this.state.projectDir);
      q.status = 'done';
      this.notify(q.id, `About your question "${question.slice(0, 60)}": ${q.answer}`);
    } catch (err) {
      q.status = 'failed';
      q.answer = err instanceof Error ? err.message : String(err);
      this.notify(q.id, `I couldn't look that up: ${q.answer.slice(0, 120)}`);
    }
    this.publish();
    return q;
  }
}
