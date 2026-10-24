import Fastify from 'fastify';
import cors from '@fastify/cors';
import websocket from '@fastify/websocket';
import { resolve } from 'node:path';
import type { ServerMessage } from '../../shared/types.ts';
import { Orchestrator } from './orchestrator.ts';
import { FakeAdapter } from './fakeAdapter.ts';
import { CodexAdapter } from './codexAdapter.ts';
import { registerCustomLlm } from './customLlm.ts';
import { EventAnalyst } from './eventAnalyst.ts';
import { registerSettings, syncAgentTurnSettings, syncAgentKeywords } from './settings.ts';
import { providers } from './llm.ts';
import { buildVocabulary } from './vocabulary.ts';

const PORT = Number(process.env.PORT ?? 3000);
const PROJECT_DIR = resolve(process.env.PROJECT_DIR ?? '../demo-project');
const DATA_DIR = resolve(process.env.DATA_DIR ?? './data');

const adapter = process.env.PROVIDER === 'fake' ? new FakeAdapter() : new CodexAdapter(process.env.CODEX_MODEL);
const orchestrator = new Orchestrator(adapter, PROJECT_DIR, DATA_DIR);
const analyst = new EventAnalyst(orchestrator);
let vocabulary: string[] = [];
const refreshVocabulary = async () => {
  vocabulary = buildVocabulary(PROJECT_DIR);
  try {
    if (await syncAgentKeywords(vocabulary)) app.log.info({ count: vocabulary.length, sample: vocabulary.slice(0, 12) }, 'asr keywords synced from project');
  } catch (err) {
    app.log.warn(`keyword sync failed: ${(err as Error).message}`);
  }
};
orchestrator.on('taskFinished', () => void refreshVocabulary());

const app = Fastify({ logger: { level: 'info' } });
await app.register(cors, { origin: true });
await app.register(websocket);
registerCustomLlm(app, orchestrator, process.env.CUSTOM_LLM_SECRET, () => analyst.memory, () => vocabulary);
registerSettings(app);

const sockets = new Set<{ send(data: string): void }>();
const broadcast = (msg: ServerMessage) => {
  const data = JSON.stringify(msg);
  for (const s of sockets) s.send(data);
};
orchestrator.on('state', state => broadcast({ type: 'state', state }));
orchestrator.on('event', event => broadcast({ type: 'event', event }));
orchestrator.on('notification', notification => broadcast({ type: 'notification', notification }));
orchestrator.on('transcript', entry => broadcast({ type: 'transcript', entry }));

app.get('/ws', { websocket: true }, socket => {
  sockets.add(socket);
  socket.send(JSON.stringify({ type: 'state', state: orchestrator.getState() } satisfies ServerMessage));
  socket.on('close', () => sockets.delete(socket));
});

app.get('/api/state', async () => orchestrator.getState());

app.get('/api/vocabulary', async () => ({ keywords: vocabulary }));

app.get('/api/config', async () => ({ agentId: process.env.ELEVENLABS_AGENT_ID ?? null, previewUrl: process.env.PREVIEW_URL ?? 'http://localhost:5174' }));

app.post<{ Body: { text: string; source?: 'ui' | 'voice' } }>('/api/tasks', async (req, reply) => {
  const text = req.body?.text?.trim();
  if (!text) return reply.code(400).send({ error: 'text required' });
  return orchestrator.enqueue(text, req.body.source ?? 'ui');
});

app.delete<{ Params: { id: string } }>('/api/tasks/:id', async (req, reply) => {
  const ok = orchestrator.cancelQueued(req.params.id);
  return ok ? { ok } : reply.code(404).send({ error: 'not a queued task' });
});

app.post('/api/stop', async () => {
  await orchestrator.stop();
  return orchestrator.getState();
});

app.post('/api/reset-project', async () => ({ result: await orchestrator.resetProject() }));

app.post('/api/reset', async () => {
  await orchestrator.reset();
  return orchestrator.getState();
});

app.post('/api/resume', async () => {
  orchestrator.resume();
  return orchestrator.getState();
});

app.post<{ Body: { question: string } }>('/api/research', async (req, reply) => {
  const question = req.body?.question?.trim();
  if (!question) return reply.code(400).send({ error: 'question required' });
  return orchestrator.research(question);
});

app.post<{ Params: { id: string } }>('/api/notifications/:id/ack', async req => {
  orchestrator.ackNotification(req.params.id);
  return { ok: true };
});

await app.listen({ port: PORT, host: '0.0.0.0' });
app.log.info(`project dir: ${PROJECT_DIR}`);
app.log.info(`llm chain: ${providers.map(p => p.name).join(' -> ')}`);
syncAgentTurnSettings().then(s => app.log.info(s, 'agent turn settings synced')).catch(err => app.log.warn(err.message));
void refreshVocabulary();
