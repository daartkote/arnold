const MODEL = process.env.GEMMA_MODEL ?? 'gemma-4-26b-a4b-it';
const KEY = process.env.GEMINI_API_KEY ?? '';

export interface GemmaResult {
  text: string;
  ms: number;
}

export async function gemma(prompt: string, opts: { json?: boolean; maxTokens?: number } = {}): Promise<GemmaResult> {
  const t0 = Date.now();
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      generationConfig: {
        ...(opts.json ? { responseMimeType: 'application/json' } : {}),
        maxOutputTokens: opts.maxTokens ?? 400,
        thinkingConfig: { thinkingLevel: 'minimal' },
      },
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    }),
  });
  if (!res.ok) throw new Error(`gemma http ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const data = (await res.json()) as { candidates?: { content?: { parts?: { text?: string; thought?: boolean }[] } }[] };
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.filter(p => !p.thought).map(p => p.text ?? '').join('').trim();
  return { text, ms: Date.now() - t0 };
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
