import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class EventLog {
  private file: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    this.file = join(dir, `events-${new Date().toISOString().slice(0, 10)}.jsonl`);
  }

  append(entry: unknown) {
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }
}
