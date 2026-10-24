const MODELS = (process.env.GEMMA_MODELS ?? process.env.GEMMA_MODEL ?? 'gemma-4-26b-a4b-it,gemini-3.8-flash').split(',').map(m => m.trim()).filter(Boolean);
const KEY = process.env.GEMINI_API_KEY ?? '';
const TIMEOUT_MS = Number(process.env.GEMMA_TIMEOUT_MS ?? 12000);

export interface GemmaResult {
  text: string;
  ms: number;
  model: string;
}

async function callModel(model: string, prompt: string, opts: { json?: boolean; maxTokens?: number }): Promise<string> {
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    body: JSON.stringify({
      generationConfig: {
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        maxOutputTokens: opts.maxTokens ?? 400,
        ...(model.startsWith('gemma') ? { thinkingConfig: { thinkingLevel: 'minimal' } } : {}),
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`${model} http ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 120)}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter(p => !p.thought).map(p => p.text ?? '').join('').trim();
  if (!text) throw new Error(`${model} returned empty text`);
  return text;
}

export async function gemma(prompt: string, opts: { json?: boolean; maxTokens?: number } = {}): Promise<GemmaResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  for (const model of MODELS) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await callModel(model, prompt, opts);
        if (errors.length) console.log(`[gemma] recovered with ${model} after: ${errors.join(' | ')}`);
        return { text, ms: Date.now() - t0, model };
      } catch (err) {
        errors.push((err as Error).message);
        if (!/http 5\d\d|timeout|aborted|empty text/i.test((err as Error).message)) break;
      }
    }
  }
  throw new Error(`all models failed: ${errors.join(' | ')}`);
}

export function parseJsonObject<T>(text: string): T | null {
  const cleaned = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  const candidates = [cleaned];
  const start = cleaned.search(/[[{]/);
  if (start > 0) candidates.push(cleaned.slice(start));
  for (const c of candidates) {
    try {
      const v = JSON.parse(c);
      return (Array.isArray(v) ? v[0] : v) as T;
    } catch {}
  }
  return null;
}
