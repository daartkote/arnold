import type { AgentAdapter, RunContext, RunResult } from './adapter.ts';

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

export class FakeAdapter implements AgentAdapter {
  readonly name = 'fake';
  private aborted = false;

  async run(prompt: string, ctx: RunContext, onEvent: (e: any) => void): Promise<RunResult> {
    this.aborted = false;
    const threadId = ctx.threadId ?? `fake-${Date.now()}`;
    onEvent({ ts: Date.now(), type: 'thread.started', summary: `thread ${threadId}` });
    for (let i = 1; i <= 5; i++) {
      if (this.aborted) return { threadId, summary: 'interrupted', commandsRun: i - 1, commandsFailed: 0, files: [], completed: false };
      await sleep(1500);
      onEvent({ ts: Date.now(), type: 'command_execution', summary: `step ${i}/5 for "${prompt.slice(0, 30)}"` });
    }
    onEvent({ ts: Date.now(), type: 'turn.completed', summary: 'turn completed' });
    return { threadId, summary: `Pretended to do: ${prompt}`, commandsRun: 5, commandsFailed: 0, files: ['src/App.tsx'], completed: true };
  }

  async stop() {
    this.aborted = true;
  }

  async research(question: string) {
    await sleep(2000);
    return `Fake answer to: ${question}`;
  }
}
