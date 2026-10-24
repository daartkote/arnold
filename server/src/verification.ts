import type { AgentEvent, Task } from '../../shared/types.ts';

const BUILD = /\b(npm run build|pnpm build|yarn build|vite build|tsc\b|next build|cargo build|go build|mvn package|gradle build|make\b)/i;
const TEST = /\b(npm test|npm run test|pnpm test|yarn test|vitest|jest|pytest|mocha|playwright|cypress|cargo test|go test)\b/i;
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

export function enforceVerificationClaims(speech: string, v: Task['verification'] | undefined): string {
  if (!v) return speech;
  let out = speech;
  if (v.tests === 'not run') {
    out = out
      .replace(/\b(build|builds)\s+and\s+(unit\s+|all\s+)?tests?\s+(passed|pass|succeeded|succeed)\b/gi, '$1 $3')
      .replace(/\b(,?\s*and\s+)?(unit\s+|all\s+)?tests?\s+(all\s+)?(passed|pass|succeeded|succeed|are\s+green|green)\b/gi, '');
  }
  if (v.build === 'not run') {
    out = out
      .replace(/,?\s*(and\s+)?(the\s+)?(production\s+)?build\s+(succeeded|passed|is green|compiles?|completed|ran)(\s+successfully)?(\s+(with no errors|cleanly|with exit code 0|exit(ed)?\s+(code\s+)?0))?/gi, '')
      .replace(/,?\s*(and\s+)?(npm run build|the build)\s+(exited|returned|exit code)\s+(code\s+)?0/gi, '')
      .replace(/\s*\.\s*\./g, '.');
    if (!/^\s*$/.test(out) && !/[.!?]$/.test(out.trim())) out = `${out.trim()}.`;
    out = `${out.trim()} No build was run.`;
  }
  if (v.build === 'failed' && !/fail|exit(ed)?\s+(code\s+)?[1-9]/i.test(out)) out = `${out.trim()} The build failed.`;
  return out.replace(/\s{2,}/g, ' ').replace(/\s+([.,])/g, '$1').replace(/,\s*\./g, '.').trim();
}
