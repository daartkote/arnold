import type { FastifyInstance } from 'fastify';
import type { Orchestrator } from './orchestrator.ts';
import { converse, type Action } from './conversation.ts';

interface ChatRequest {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  stream?: boolean;
}

export async function applyActions(actions: Action[], orchestrator: Orchestrator): Promise<string[]> {
  const notes: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case 'enqueue_task':
        if (a.text?.trim()) { const t = orchestrator.enqueue(a.text.trim(), 'voice'); notes.push(`enqueued ${t.id}`); }
        break;
      case 'cancel_queued_task': {
        const id = a.task_id ?? orchestrator.queuedTasks().find(t => a.text && t.text.toLowerCase().includes(a.text.toLowerCase()))?.id;
        if (id) notes.push(orchestrator.cancelQueued(id) ? `cancelled ${id}` : `not queued ${id}`);
        break;
      }
      case 'research_project':
        if (a.question?.trim()) { void orchestrator.research(a.question.trim()); notes.push('research started'); }
        break;
      case 'stop':
        await orchestrator.stop(); notes.push('stopped');
        break;
      case 'resume':
        orchestrator.resume(); notes.push('resumed');
        break;
      case 'get_status':
        break;
    }
  }
  return notes;
}

export function registerCustomLlm(app: FastifyInstance, orchestrator: Orchestrator, secret: string | undefined) {
  app.post<{ Body: ChatRequest }>('/v1/chat/completions', async (req, reply) => {
    if (secret && req.headers['x-voicecode-secret'] !== secret && req.headers.authorization !== `Bearer ${secret}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body ?? { messages: [] };
    const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === 'user')?.content ?? '';
    app.log.info({ lastUser: lastUser.slice(0, 120) }, 'custom llm request');

    let speech: string;
    try {
      const result = await converse(body.messages ?? [], orchestrator.getState());
      speech = result.speech;
      const notes = await applyActions(result.actions, orchestrator);
      if (notes.length) app.log.info({ notes }, 'actions applied');
    } catch (err) {
      app.log.error(err);
      speech = 'Sorry, my language model hiccuped. Say that again?';
    }

    const id = `chatcmpl-${Date.now()}`;
    const created = Math.floor(Date.now() / 1000);
    const model = body.model ?? 'gemma';
    if (body.stream === false) {
      return { id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: speech }, finish_reason: 'stop' }] };
    }
    reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const chunk = (delta: object, finish: string | null) =>
      reply.raw.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
    chunk({ role: 'assistant', content: '' }, null);
    chunk({ content: speech }, null);
    chunk({}, 'stop');
    reply.raw.write('data: [DONE]\n\n');
    reply.raw.end();
    return reply;
  });
}
