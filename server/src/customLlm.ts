import type { FastifyInstance } from 'fastify';
import type { Orchestrator } from './orchestrator.ts';
import { converse, type Action } from './conversation.ts';
import { settings } from './settings.ts';

const DEDUP_WINDOW_MS = 45000;
let lastActed = { text: '', at: 0 };

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9а-яё ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

const CUT_OFF = /\b(and|with|then|or|to|the|a|an|of|for|but|also|plus|that|which|so)\s*[,.…]*\s*$/i;

export function looksCutOff(text: string): boolean {
  return CUT_OFF.test(text.trim()) || /,\s*$/.test(text.trim());
}

export function isDuplicateUtterance(text: string, now = Date.now()): boolean {
  const n = normalize(text);
  if (!n || now - lastActed.at > DEDUP_WINDOW_MS) return false;
  const prev = lastActed.text;
  return n === prev || n.startsWith(prev) || prev.startsWith(n);
}

function similar(a: string, b: string): boolean {
  const ta = new Set(normalize(a).split(' ').filter(w => w.length > 3));
  const tb = new Set(normalize(b).split(' ').filter(w => w.length > 3));
  if (!ta.size || !tb.size) return false;
  let common = 0;
  for (const w of ta) if (tb.has(w)) common++;
  return common / Math.min(ta.size, tb.size) >= 0.6;
}

function markActed(text: string, now = Date.now()) {
  lastActed = { text: normalize(text), at: now };
}

interface ChatRequest {
  model?: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  stream?: boolean;
}

export async function applyActions(actions: Action[], orchestrator: Orchestrator): Promise<string[]> {
  const notes: string[] = [];
  for (const a of actions) {
    switch (a.type) {
      case 'enqueue_task': {
        const text = a.text?.trim();
        if (!text) break;
        const state = orchestrator.getState();
        const open = state.tasks.filter(t => t.status === 'queued' || t.status === 'running' || t.status === 'cancelling');
        const dup = open.find(t => similar(t.text, text));
        if (dup) {
          const words = (x: string) => x.split('\n')[0].split(/\s+/).length;
          const richer = words(text) >= words(dup.text) * 1.5;
          if (richer && dup.status === 'queued') { orchestrator.updateQueued(dup.id, text); notes.push(`updated queued ${dup.id} with more detail`); }
          else if (richer) { const f = orchestrator.enqueue(`Additional requirements for the task you are working on: ${text}`, 'voice'); notes.push(`follow-up ${f.id} for running ${dup.id}`); }
          else notes.push(`duplicate of ${dup.id}, not enqueued`);
          break;
        }
        const t = orchestrator.enqueue(text, 'voice');
        notes.push(`enqueued ${t.id}`);
        break;
      }
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
      case 'new_session':
        await orchestrator.reset(); notes.push('session reset');
        break;
      case 'reset_project':
        notes.push(await orchestrator.resetProject());
        break;
      case 'get_status':
        break;
    }
  }
  return notes;
}

export function registerCustomLlm(app: FastifyInstance, orchestrator: Orchestrator, secret: string | undefined, memory: () => string[], vocabulary: () => string[]) {
  app.post<{ Body: ChatRequest }>('/v1/chat/completions', async (req, reply) => {
    if (secret && req.headers['x-voicecode-secret'] !== secret && req.headers.authorization !== `Bearer ${secret}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body ?? { messages: [] };
    const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === 'user')?.content ?? '';
    app.log.info({ lastUser: lastUser.slice(0, 120) }, 'custom llm request');

    let speech: string;
    const silentTurn = !lastUser.replace(/[.\s…]/g, '').length;
    if (silentTurn) {
      app.log.info('silent turn');
      speech = orchestrator.unannouncedTasks().length ? 'Quick update.' : 'Still here.';
    } else if (lastUser.startsWith('[notification]')) {
      const text = lastUser.slice('[notification]'.length).trim();
      const matched = orchestrator.getState().notifications.find(n => n.text === text || text.startsWith(n.text.slice(0, 80)));
      if (matched) orchestrator.ackNotification(matched.id);
      orchestrator.markAnnounced(orchestrator.unannouncedTasks().map(t => t.id));
      orchestrator.transcript('system', `spoken verbatim: ${text}`, { delivered: Boolean(matched) });
      speech = text;
    } else try {
      orchestrator.transcript('user', lastUser);
      const unannouncedBefore = orchestrator.unannouncedTasks().map(t => t.id);
      const result = await converse(body.messages ?? [], orchestrator.getState(), memory(), vocabulary());
      speech = result.speech;
      orchestrator.transcript('gemma', speech, { actions: result.actions });
      if (unannouncedBefore.length) orchestrator.markAnnounced(unannouncedBefore);
      const hasSideEffects = result.actions.some(a => a.type !== 'get_status');
      if (hasSideEffects && looksCutOff(lastUser)) {
        app.log.info({ actions: result.actions.map(a => a.type) }, 'utterance looks cut off, waiting for the rest');
        speech = 'Go on, I am listening.';
      } else if (hasSideEffects && isDuplicateUtterance(lastUser)) {
        app.log.info({ actions: result.actions.map(a => a.type) }, 'duplicate utterance, actions skipped');
      } else if (hasSideEffects && settings.dryRun) {
        app.log.info({ actions: result.actions }, 'dry run, actions not executed');
        speech = `${speech} (Dry run: I would ${result.actions.map(a => a.type.replace('_', ' ')).join(' and ')}.)`;
      } else {
        const notes = await applyActions(result.actions, orchestrator);
        if (notes.length) { app.log.info({ notes }, 'actions applied'); markActed(lastUser); }
      }
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
