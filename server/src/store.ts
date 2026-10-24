import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export class EventLog {
  private file: string;
  private transcriptFile: string;

  constructor(dir: string) {
    mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    this.file = join(dir, `events-${day}.jsonl`);
    this.transcriptFile = join(dir, `transcript-${day}.jsonl`);
  }

  append(entry: unknown) {
    appendFileSync(this.file, JSON.stringify(entry) + '\n');
  }

  appendTranscript(entry: unknown) {
    appendFileSync(this.transcriptFile, JSON.stringify(entry) + '\n');
  }
}
