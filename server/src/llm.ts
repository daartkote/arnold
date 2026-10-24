export interface LlmResult {
  text: string;
  ms: number;
  model: string;
}

interface LlmOpts {
  json?: boolean;
  maxTokens?: number;
}

interface Provider {
  name: string;
  call(prompt: string, opts: LlmOpts): Promise<string>;
}

const TIMEOUT_MS = Number(process.env.LLM_TIMEOUT_MS ?? process.env.GEMMA_TIMEOUT_MS ?? 6000);
const GEMINI_KEY = process.env.GEMINI_API_KEY ?? '';
const GROQ_KEY = process.env.GROQ_API_KEY ?? '';
const GROQ_MODEL = process.env.GROQ_MODEL ?? 'openai/gpt-oss-120b';
const GEMINI_MODELS = (process.env.GEMMA_MODELS ?? process.env.GEMMA_MODEL ?? 'gemma-4-26b-a4b-it,gemini-3.8-flash').split(',').map(m => m.trim()).filter(Boolean);

function openAiCompatible(name: string, baseUrl: string, key: string, model: string): Provider {
  return {
    name: `${name}:${model}`,
    async call(prompt, opts) {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${key}` },
        signal: AbortSignal.timeout(TIMEOUT_MS),
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: prompt }],
          max_tokens: opts.maxTokens ?? 400,
          temperature: 0.3,
          ...(opts.json ? { response_format: { type: 'json_object' } } : {}),
          ...(model.includes('gpt-oss') ? { reasoning_effort: 'low' } : {}),
        }),
      });
      if (!res.ok) throw new Error(`${name} http ${res.status}: ${(await res.text()).replace(/\s+/g, ' ').slice(0, 160)}`);
      const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
      const text = data.choices?.[0]?.message?.content?.trim() ?? '';
      if (!text) throw new Error(`${name} returned empty text`);
      return text;
    },
  };
}

function gemini(model: string): Provider {
  return {
    name: `gemini:${model}`,
    async call(prompt, opts) {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`, {
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
    },
  };
}

export const providers: Provider[] = [
  ...(GROQ_KEY ? [openAiCompatible('groq', 'https://api.groq.com/openai/v1', GROQ_KEY, GROQ_MODEL)] : []),
  ...GEMINI_MODELS.map(gemini),
];

const RETRYABLE = /http 5\d\d|http 429|timeout|aborted|empty text/i;

export async function llm(prompt: string, opts: LlmOpts = {}): Promise<LlmResult> {
  const t0 = Date.now();
  const errors: string[] = [];
  for (const p of providers) {
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const text = await p.call(prompt, opts);
        if (errors.length) console.log(`[llm] recovered with ${p.name} after: ${errors.join(' | ')}`);
        return { text, ms: Date.now() - t0, model: p.name };
      } catch (err) {
        errors.push((err as Error).message);
        if (!RETRYABLE.test((err as Error).message)) break;
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
