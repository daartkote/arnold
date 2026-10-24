import type { AgentEvent, Task } from '../../shared/types.ts';

export const BUILD = /\b(npm run build|pnpm build|yarn build|vite build|tsc\b|next build|cargo build|go build|mvn package|gradle build|make\b)/i;
export const TEST = /\b(npm test|npm run test|pnpm test|yarn test|vitest|jest|pytest|mocha|playwright|cypress|cargo test|go test)\b/i;
const WRITE = /(\bsed -i\b|\bapply_patch\b|\bpython3? -(c|\s*<<)|\bcat >|\btee\s+\S|\s>\s*\S+\.(tsx?|jsx?|css|json|md|py|go|rs|html)\b)/i;

type Outcome = 'passed' | 'failed' | 'not run';

function outcome(events: AgentEvent[], re: RegExp): Outcome {
  let result: Outcome = 'not run';
  for (const e of events) {
    if (e.type !== 'item.completed:command_execution') continue;
    const item = (e.raw as { item?: { command?: string; exit_code?: number } } | undefined)?.item;
    if (!item?.command || !re.test(item.command)) continue;
    result = (item.exit_code ?? 1) === 0 ? 'passed' : 'failed';
  }
  return result;
}

export function verificationFor(events: AgentEvent[]): NonNullable<Task['verification']> {
  return { build: outcome(events, BUILD), tests: outcome(events, TEST) };
}

export function batchHasVerificationFailure(events: AgentEvent[]): boolean {
  return events.some(e => {
    if (e.type !== 'item.completed:command_execution') return false;
    const item = (e.raw as { item?: { command?: string; exit_code?: number } } | undefined)?.item;
    return Boolean(item?.command && (BUILD.test(item.command) || TEST.test(item.command) || /\b(npm|pnpm|yarn) (install|ci)\b/.test(item.command)) && (item.exit_code ?? 0) !== 0);
  });
}

export function batchWritesFiles(events: AgentEvent[]): boolean {
  return events.some(e => {
    if (e.type === 'item.completed:file_change') return true;
    if (e.type !== 'item.completed:command_execution') return false;
    const item = (e.raw as { item?: { command?: string } } | undefined)?.item;
    return Boolean(item?.command && WRITE.test(item.command));
  });
}

export function filesWrittenIn(events: AgentEvent[]): string[] {
  const out = new Set<string>();
  for (const e of events) {
    if (e.type !== 'item.completed:file_change') continue;
    const item = (e.raw as { item?: { changes?: { path?: string }[] } } | undefined)?.item;
    for (const c of item?.changes ?? []) if (c.path) out.add(c.path.split('/').slice(-2).join('/'));
  }
  return [...out];
}

export function describeVerification(v: Task['verification'] | undefined): string {
  if (!v) return 'not verified';
  const parts = [`build ${v.build}`];
  if (v.tests !== 'not run') parts.push(`tests ${v.tests}`);
  return parts.join(', ');
}
