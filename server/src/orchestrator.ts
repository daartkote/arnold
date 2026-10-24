import { EventEmitter } from 'node:events';
import { nanoid } from 'nanoid';
import type { AgentEvent, AppState, Notification, ResearchQuery, Task, TaskSource, TranscriptEntry, TranscriptKind } from '../../shared/types.ts';
import type { AgentAdapter } from './adapter.ts';
import { EventLog } from './store.ts';

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

  unannouncedTasks(): Task[] {
    return this.state.tasks.filter(t => ['done', 'failed', 'interrupted'].includes(t.status) && !t.announcedAt);
  }

  markAnnounced(ids: string[]) {
    const now = Date.now();
    for (const t of this.state.tasks) if (ids.includes(t.id)) t.announcedAt = now;
    this.publish();
  }

  enqueue(text: string, source: TaskSource): Task {
    const task: Task = { id: nanoid(8), text, status: 'queued', source, createdAt: Date.now() };
    this.state.tasks.push(task);
    this.log.append({ kind: 'task', task });
    this.transcript('codex_prompt', text, { taskId: task.id, source });
    this.publish();
    void this.pump();
    return task;
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
    const next = this.queuedTasks()[0];
    if (!next) return;
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
      const wasCancelling = (next.status as Task['status']) === 'cancelling';
      if (wasCancelling || !result.completed) next.status = 'interrupted';
      else next.status = result.commandsFailed > 0 ? 'failed' : 'done';
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
