export type TaskStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'done'
  | 'waiting'
  | 'failed'
  | 'interrupted'
  | 'cancelled';

export type TaskSource = 'voice' | 'ui';

export interface Task {
  id: string;
  text: string;
  status: TaskStatus;
  source: TaskSource;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  summary?: string;
  commandsRun?: number;
  commandsFailed?: number;
  files?: string[];
  question?: string;
  verification?: { build: 'passed' | 'failed' | 'not run'; tests: 'passed' | 'failed' | 'not run' };
  announcedAt?: number;
}

export type TranscriptKind = 'user' | 'gemma' | 'codex_prompt' | 'analyst' | 'notification' | 'system';

export interface TranscriptEntry {
  id: string;
  ts: number;
  kind: TranscriptKind;
  text: string;
  meta?: Record<string, unknown>;
}

export interface AgentEvent {
  id: string;
  taskId: string;
  ts: number;
  type: string;
  summary: string;
  raw?: unknown;
}

export interface Notification {
  id: string;
  taskId: string;
  ts: number;
  text: string;
}

export interface ResearchQuery {
  id: string;
  question: string;
  status: 'running' | 'done' | 'failed';
  answer?: string;
  createdAt: number;
}

export interface AppState {
  provider: string;
  projectDir: string;
  paused: boolean;
  activeTaskId: string | null;
  threadId: string | null;
  tasks: Task[];
  events: AgentEvent[];
  notifications: Notification[];
  research: ResearchQuery[];
  transcript: TranscriptEntry[];
}

export type ServerMessage =
  | { type: 'state'; state: AppState }
  | { type: 'event'; event: AgentEvent }
  | { type: 'notification'; notification: Notification }
  | { type: 'transcript'; entry: TranscriptEntry };
