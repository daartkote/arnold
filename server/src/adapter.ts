import type { AgentEvent } from '../../shared/types.ts';

export interface RunContext {
  taskId: string;
  projectDir: string;
  threadId: string | null;
}

export interface RunResult {
  threadId: string | null;
  summary: string;
  commandsRun: number;
  commandsFailed: number;
  files: string[];
  lastExitCode: number | null;
  completed: boolean;
}

export interface AgentAdapter {
  readonly name: string;
  run(prompt: string, ctx: RunContext, onEvent: (e: Omit<AgentEvent, 'id' | 'taskId'>) => void): Promise<RunResult>;
  stop(): Promise<void>;
  research(question: string, projectDir: string): Promise<string>;
}
