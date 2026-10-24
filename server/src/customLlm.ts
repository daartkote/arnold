import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Orchestrator } from './orchestrator.ts';
import { converse, type Action } from './conversation.ts';
import { settings } from './settings.ts';

const DEDUP_WINDOW_MS = 45000;
let lastActed = { text: '', at: 0 };

function normalize(s: string) {
  return s.toLowerCase().replace(/[^a-z0-9а-яё ]+/g, ' ').replace(/\s+/g, ' ').trim();
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
        if (orchestrator.waitingTask() && !orchestrator.getState().activeTaskId) {
          const t = orchestrator.answerWaiting(text);
          notes.push(`answer → continues thread as ${t?.id}`);
          break;
        }
        orchestrator.propose(text);
        notes.push('proposed');
        break;
      }
      case 'confirm_task': {
        const state = orchestrator.getState();
        const text = state.proposal?.text;
        if (!text) { notes.push('nothing to confirm'); break; }
        const open = state.tasks.filter(t => t.status === 'queued' || t.status === 'running' || t.status === 'cancelling');
        const dup = open.find(t => similar(t.text, text));
        if (dup) { orchestrator.rejectProposal(); notes.push(`duplicate of ${dup.id}, not enqueued`); break; }
        const t = orchestrator.confirmProposal();
        if (t) notes.push(`confirmed → enqueued ${t.id}`);
        break;
      }
      case 'reject_task':
        orchestrator.rejectProposal(); notes.push('proposal rejected');
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

interface Answered { speech: string; at: number; promise?: Promise<string> }
const recent = new Map<string, Answered>();
const REQUEST_DEDUP_MS = 8000;

function recentKey(text: string) {
  return normalize(text);
}

export function registerCustomLlm(app: FastifyInstance, orchestrator: Orchestrator, secret: string | undefined, memory: () => string[], vocabulary: () => string[]) {
  app.post<{ Body: ChatRequest }>('/v1/chat/completions', async (req, reply) => {
    if (secret && req.headers['x-voicecode-secret'] !== secret && req.headers.authorization !== `Bearer ${secret}`) {
      return reply.code(401).send({ error: 'unauthorized' });
    }
    const body = req.body ?? { messages: [] };
    const lastUser = [...(body.messages ?? [])].reverse().find(m => m.role === 'user')?.content ?? '';
    app.log.info({ lastUser: lastUser.slice(0, 120) }, 'custom llm request');

    const key = recentKey(lastUser);
    const prior = key ? recent.get(key) : undefined;
    if (prior && Date.now() - prior.at < REQUEST_DEDUP_MS) {
      app.log.info('repeated request, reusing the answer');
      const speech = prior.promise ? await prior.promise : prior.speech;
      return sendSpeech(reply, body, speech);
    }
    let resolveSpeech: (s: string) => void = () => {};
    const inflight = new Promise<string>(r => { resolveSpeech = r; });
    if (key) recent.set(key, { speech: '', at: Date.now(), promise: inflight });

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
      orchestrator.transcript('gemma', speech, { actions: result.actions, analysis: result.analysis });
      if (unannouncedBefore.length) orchestrator.markAnnounced(unannouncedBefore);
      const proposal = orchestrator.getState().proposal;
      if (proposal && result.analysis?.intent === 'confirm') {
        result.actions = [{ type: 'confirm_task' }];
        if (/\?\s*$/.test(speech.trim())) speech = 'Starting now.';
      } else if (proposal && result.analysis?.intent === 'reject') {
        result.actions = [{ type: 'reject_task' }];
        if (/\?\s*$/.test(speech.trim())) speech = 'Dropped it.';
      }
      if (result.analysis && !result.analysis.complete) orchestrator.setFragment(lastUser);
      else if (orchestrator.getState().fragment) orchestrator.setFragment(null);
      const asksUser = /\?\s*$/.test(speech.trim()) && !/^\[notification\]/.test(lastUser);
      if (asksUser && result.actions.some(a => a.type !== 'get_status' && a.type !== 'enqueue_task')) {
        app.log.info({ dropped: result.actions.map(a => a.type) }, 'agent asked a question, actions deferred');
        result.actions = [];
      }
      const hasSideEffects = result.actions.some(a => a.type !== 'get_status');
      if (hasSideEffects && isDuplicateUtterance(lastUser)) {
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

    if (key) recent.set(key, { speech, at: Date.now() });
    resolveSpeech(speech);
    for (const [k, v] of recent) if (Date.now() - v.at > REQUEST_DEDUP_MS * 4) recent.delete(k);
    return sendSpeech(reply, body, speech);
  });
}

function sendSpeech(reply: FastifyReply, body: ChatRequest, speech: string) {
  const id = `chatcmpl-${Date.now()}`;
  const created = Math.floor(Date.now() / 1000);
  const model = body.model ?? 'gemma';
  if (body.stream === false) {
    return reply.send({ id, object: 'chat.completion', created, model, choices: [{ index: 0, message: { role: 'assistant', content: speech }, finish_reason: 'stop' }] });
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
}
