import type { AppState } from '../../shared/types.ts';
import { gemma, parseJsonObject } from './gemma.ts';

export type Action =
  | { type: 'enqueue_task'; text: string }
  | { type: 'cancel_queued_task'; task_id?: string; text?: string }
  | { type: 'get_status' }
  | { type: 'research_project'; question: string }
  | { type: 'stop' }
  | { type: 'resume' };

export interface ConversationReply {
  speech: string;
  actions: Action[];
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function describeState(state: AppState): string {
  const active = state.tasks.find(t => t.id === state.activeTaskId);
  const queued = state.tasks.filter(t => t.status === 'queued');
  const recent = state.tasks.filter(t => ['done', 'failed', 'interrupted', 'cancelled'].includes(t.status)).slice(-3);
  const research = state.research.filter(r => r.status === 'done').slice(-1);
  const unannounced = state.tasks.filter(t => ['done', 'failed', 'interrupted'].includes(t.status) && !t.announcedAt);
  const lines = [
    `Provider: ${state.provider}. Queue ${state.paused ? 'PAUSED' : 'running'}.`,
    unannounced.length ? `FINISHED BUT NOT YET TOLD TO THE USER (you MUST mention these in your reply, briefly, before anything else):\n${unannounced.map(t => `  - ${t.status}: ${t.text} => ${(t.summary ?? '').slice(0, 300)} (commands run: ${t.commandsRun ?? 0}, failed: ${t.commandsFailed ?? 0})`).join('\n')}` : '',
    active ? `Active task [${active.id}] (${active.status}): ${active.text}` : 'No active task.',
    queued.length ? `Queued:\n${queued.map((t, i) => `  ${i + 1}. [${t.id}] ${t.text}`).join('\n')}` : 'Queue is empty.',
    recent.length ? `Recent results:\n${recent.map(t => `  - ${t.status}: ${t.text} => ${(t.summary ?? '').slice(0, 200)}`).join('\n')}` : '',
    research.length ? `Latest research answer: ${research[0].answer?.slice(0, 400)}` : '',
    state.notifications.length ? `Pending notifications from the coding agent:\n${state.notifications.map(n => `  - ${n.text}`).join('\n')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

const RULES = `You are VoiceCode, a hands-free voice interface between a developer and a coding agent working on a software project.
You talk briefly and naturally, like a colleague over a headset. 1-2 sentences, no markdown, no lists, no code.
You NEVER claim code was written, tests passed or a build succeeded unless the state below says so. Unverified means unverified.

You respond ONLY with one JSON object: {"speech": string, "actions": Action[]}
Action types:
- {"type":"enqueue_task","text":string} when the user asks to change, add, fix or build something in the project. Rewrite the request as a clear self-contained instruction for the coding agent.
- {"type":"cancel_queued_task","task_id":string} to remove a queued (not active) task.
- {"type":"research_project","question":string} when the user asks a question about the codebase (how is X stored, where is Y, what does Z do). This runs read-only while coding continues; say you'll look it up.
- {"type":"stop"} when the user clearly wants to stop/abort the current work.
- {"type":"resume"} when the user wants to continue the paused queue.
- {"type":"get_status"} when the user asks what's happening; answer from the state.
Chit-chat or clarifications need no actions. If the request is ambiguous, ask one short question instead of enqueueing.
If the state lists pending notifications and the latest user message is a notification relay (starts with [notification]), announce it in one sentence truthfully.
When the user asks what was done or whether something is finished, answer from "Recent results" and the finished-tasks list; those are authoritative.`;

export async function converse(messages: ChatMessage[], state: AppState, memory: string[] = []): Promise<ConversationReply> {
  const history = messages
    .filter(m => m.role !== 'system')
    .slice(-12)
    .map(m => `${m.role === 'user' ? 'User' : 'VoiceCode'}: ${m.content}`)
    .join('\n');
  const notes = memory.slice(-8).map(n => `- ${n}`).join('\n');
  const prompt = `${RULES}\n\n=== CURRENT STATE ===\n${describeState(state)}${notes ? `\n\n=== NOTES FROM THE CODING AGENT'S WORK ===\n${notes}` : ''}\n\n=== CONVERSATION ===\n${history}\n\nRespond with the JSON object only.`;
  const { text, ms, model } = await gemma(prompt, { json: true, maxTokens: 400 });
  const parsed = parseJsonObject<Partial<ConversationReply>>(text);
  if (!parsed || typeof parsed.speech !== 'string') {
    return { speech: text.slice(0, 300) || "Sorry, I didn't catch that.", actions: [] };
  }
  const actions = Array.isArray(parsed.actions) ? (parsed.actions.filter(a => a && typeof a.type === 'string') as Action[]) : [];
  console.log(`[gemma] ${model} ${ms}ms actions=${actions.map(a => a.type).join(',') || 'none'}`);
  return { speech: parsed.speech, actions };
}
