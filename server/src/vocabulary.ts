import { readdirSync, readFileSync, statSync, existsSync } from 'node:fs';
import { join, basename, extname } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', '.git', 'coverage', '.next']);
const CODE_EXT = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.py', '.go', '.rs', '.java', '.kt', '.swift', '.vue', '.svelte']);
const STOP = new Set(['default', 'export', 'import', 'return', 'const', 'function', 'interface', 'type', 'class', 'props', 'state', 'index', 'main', 'app', 'utils', 'types', 'string', 'number', 'boolean', 'void', 'null', 'undefined', 'true', 'false', 'async', 'await', 'readonly', 'static', 'public', 'private']);
const MAX_FILES = 400;
const MAX_KEYWORDS = Number(process.env.VOCAB_MAX ?? 80);

function walk(dir: string, out: string[], depth = 0) {
  if (depth > 6 || out.length >= MAX_FILES) return;
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return; }
  for (const name of entries) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    const full = join(dir, name);
    let st;
    try { st = statSync(full); } catch { continue; }
    if (st.isDirectory()) walk(full, out, depth + 1);
    else if (CODE_EXT.has(extname(name)) && st.size < 200_000) out.push(full);
    if (out.length >= MAX_FILES) return;
  }
}

function splitIdentifier(id: string): string[] {
  return id.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase().split(' ').filter(w => w.length > 2 && !STOP.has(w));
}

export function buildVocabulary(projectDir: string): string[] {
  const score = new Map<string, number>();
  const bump = (word: string, n: number) => {
    const w = word.trim();
    if (w.length < 3 || w.length > 24 || STOP.has(w.toLowerCase())) return;
    score.set(w, (score.get(w) ?? 0) + n);
  };

  const pkgPath = join(projectDir, 'package.json');
  if (existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: string; dependencies?: Record<string, string> };
      if (pkg.name) bump(pkg.name, 10);
      for (const dep of Object.keys(pkg.dependencies ?? {})) bump(dep.replace(/^@.*\//, ''), 4);
    } catch {}
  }

  for (const readme of ['README.md', 'readme.md', 'AGENTS.md']) {
    const p = join(projectDir, readme);
    if (!existsSync(p)) continue;
    const text = readFileSync(p, 'utf8');
    for (const m of text.matchAll(/^#+\s+(.+)$/gm)) for (const w of m[1].split(/[^A-Za-z0-9]+/)) bump(w, 3);
    for (const m of text.matchAll(/`([A-Za-z][A-Za-z0-9_.-]{2,30})`/g)) bump(m[1], 3);
  }

  const files: string[] = [];
  walk(projectDir, files);
  for (const f of files) {
    const base = basename(f, extname(f));
    for (const w of splitIdentifier(base)) bump(w, 2);
    bump(base, 4);
    let src = '';
    try { src = readFileSync(f, 'utf8'); } catch { continue; }
    for (const m of src.matchAll(/\b(?:interface|type|class|enum)\s+([A-Z][A-Za-z0-9]{2,})/g)) bump(m[1], 6);
    for (const m of src.matchAll(/\b(?:function|const|let)\s+([A-Za-z_][A-Za-z0-9_]{3,})\s*(?:=|\()/g)) { bump(m[1], 2); for (const w of splitIdentifier(m[1])) bump(w, 1); }
    for (const m of src.matchAll(/\b(?:interface|type)\s+\w+\s*=?\s*\{([^}]{0,2000})\}/g)) for (const field of m[1].matchAll(/^\s*([a-zA-Z_][a-zA-Z0-9_]{2,})\s*\??:/gm)) { bump(field[1], 3); for (const w of splitIdentifier(field[1])) bump(w, 1); }
    for (const m of src.matchAll(/localStorage\.(?:get|set)Item\(\s*['"]([^'"]+)['"]/g)) bump(m[1], 5);
  }

  const extra = (process.env.EXTRA_KEYWORDS ?? '').split(',').map(s => s.trim()).filter(Boolean);
  for (const w of extra) bump(w, 100);

  const seen = new Set<string>();
  const out: string[] = [];
  for (const [w] of [...score.entries()].sort((a, b) => b[1] - a[1])) {
    const key = w.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(w);
    if (out.length >= MAX_KEYWORDS) break;
  }
  return out;
}
