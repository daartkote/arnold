export type TaskStatus =
  | 'queued'
  | 'running'
  | 'cancelling'
  | 'done'
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
}

export type ServerMessage =
  | { type: 'state'; state: AppState }
  | { type: 'event'; event: AgentEvent }
  | { type: 'notification'; notification: Notification };
