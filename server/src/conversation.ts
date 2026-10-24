import type { AppState, Task } from '../../shared/types.ts';
import { llm as gemma, parseJsonObject } from './llm.ts';
import { describeVerification } from './verification.ts';

export type Action =
  | { type: 'enqueue_task'; text: string }
  | { type: 'cancel_queued_task'; task_id?: string; text?: string }
  | { type: 'get_status' }
  | { type: 'research_project'; question: string }
  | { type: 'stop' }
  | { type: 'resume' }
  | { type: 'new_session' }
  | { type: 'reset_project' };

export interface ConversationReply {
  speech: string;
  actions: Action[];
}

interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

function liveActivity(state: AppState): string {
  if (!state.activeTaskId) return '';
  const recent = state.events.filter(e => e.taskId === state.activeTaskId && !e.type.startsWith('item.started') && e.type !== 'turn.started' && e.type !== 'thread.started').slice(-8);
  if (!recent.length) return 'Codex just started, no output yet.';
  return recent.map(e => {
    const age = Math.round((Date.now() - e.ts) / 1000);
    const kind = e.type.includes('agent_message') ? 'codex says' : e.type.includes('file_change') ? 'files' : e.type.includes('command') ? 'ran' : e.type;
    return `  [${age}s ago] ${kind}: ${e.summary.slice(0, 220)}`;
  }).join('\n');
}

function describeTask(t: Task): string {
  const files = t.files?.length ? ` files: ${t.files.join(', ')}.` : '';
  return `${t.status}: "${t.text.split('\n')[0]}" => ${(t.summary ?? '').slice(0, 600)}${files} (verification: ${describeVerification(t.verification)}; commands: ${t.commandsRun ?? 0})`;
}

function describeState(state: AppState): string {
  const active = state.tasks.find(t => t.id === state.activeTaskId);
  const queued = state.tasks.filter(t => t.status === 'queued');
  const recent = state.tasks.filter(t => ['done', 'waiting', 'failed', 'interrupted', 'cancelled'].includes(t.status)).slice(-3);
  const research = state.research.filter(r => r.status === 'done').slice(-1);
  const unannounced = state.tasks.filter(t => ['done', 'waiting', 'failed', 'interrupted'].includes(t.status) && !t.announcedAt);
  const waiting = [...state.tasks].reverse().find(t => t.status === 'waiting');
  const lines = [
    `Provider: ${state.provider}. Queue ${state.paused ? 'PAUSED' : 'running'}.`,
    waiting && !active ? `THE CODING AGENT IS WAITING FOR THE USER'S ANSWER to this question: "${waiting.question}" (about the task: ${waiting.text.split('\n')[0]}). If the user's latest message answers it, emit enqueue_task with text "Answer to your question: <the user's answer>. Continue the task." The speech must be a short confirmation in your own words (e.g. "Separate input it is, continuing."), never the task text itself. If the user asks what is going on, repeat the question.` : '',
    unannounced.length ? `FINISHED BUT NOT YET TOLD TO THE USER (you MUST report these first, with the concrete details):\n${unannounced.map(t => `  - ${describeTask(t)}`).join('\n')}` : '',
    active ? `Active task [${active.id}] (${active.status}, started ${Math.round((Date.now() - (active.startedAt ?? Date.now())) / 1000)}s ago): ${active.text}\nLive activity from Codex (newest last):\n${liveActivity(state)}` : 'No active task.',
    queued.length ? `Queued:\n${queued.map((t, i) => `  ${i + 1}. [${t.id}] ${t.text}`).join('\n')}` : 'Queue is empty.',
    recent.length ? `Recent results:\n${recent.map(t => `  - ${describeTask(t)}`).join('\n')}` : '',
    research.length ? `Latest research answer: ${research[0].answer?.slice(0, 500)}` : '',
    state.notifications.length ? `Pending notifications from the coding agent:\n${state.notifications.map(n => `  - ${n.text}`).join('\n')}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

const RULES = `You are VoiceCode, the voice of a coding agent (Codex) working on a software project, talking to a software engineer over a headset.
Talk like a senior engineer pairing with a peer: concrete and technical. Name files, components, types, functions, commands and exit codes when the state has them. Never explain basics.
2-4 spoken sentences, no markdown, no bullet lists, no code blocks. Short words, you are being read aloud.
Ground everything in the state below. About the agent's work: if Codex has not reported something, say you don't know yet. About the codebase itself (how is X stored, where is Y, what does Z do, which library, what format): NEVER answer "I don't know", always emit research_project and say you'll look it up; the answer will be spoken when ready. Never claim a build passed or tests ran unless the "verification" field or a command event with exit code 0 says so. If verification says "build not run", say that the build was not run.
When asked what is happening, narrate the live activity: what Codex just said it is doing, which files it edited, what command is running and whether it passed.

You respond ONLY with one JSON object: {"speech": string, "actions": Action[]}
Action types:
- {"type":"enqueue_task","text":string} when the user asks to change, add, fix or build something in the project. Rewrite the request as a precise self-contained instruction for the coding agent, keeping the user's technical wording. Do not invent requirements the user did not state.
- {"type":"cancel_queued_task","task_id":string} to remove a queued (not active) task.
- {"type":"research_project","question":string} for ANY question about the codebase or the project's behaviour (how is X stored, where is Y, what does Z do, "by the way…"). Mandatory for such questions, even if the queue is busy. This runs read-only while coding continues; say you'll look it up.
- {"type":"stop"} when the user clearly wants to stop/abort the current work.
- {"type":"resume"} when the user wants to continue the paused queue.
- {"type":"new_session"} when the user clearly asks to start over, start a new session, or clear all tasks and history. Confirm in speech that everything was cleared.
- {"type":"reset_project"} when the user asks to reset, revert or restore the project files to the clean baseline (git reset, discard changes). This is done by the server, never by the coding agent. Confirm in speech.
Never enqueue destructive git operations (reset, checkout --, clean, push --force, branch -D) as a coding task; use reset_project or ask what the user means.
- {"type":"get_status"} when the user asks what's happening; answer from the state.
If the coding agent is waiting for an answer (see state) and the user answers, enqueue_task with the answer as described there; that continues the same agent thread.
Chit-chat or clarifications need no actions. If the request is ambiguous, ask one short question instead of enqueueing.

Transcripts come from speech recognition in a noisy room. Drop fillers and repeated words. A mis-heard word usually sounds like a term from the project vocabulary below or from the conversation so far; prefer that reading when the literal one makes no sense for this project. Write the task text as a clean engineering instruction, never quote the raw transcript. If the request still makes no sense, ask the user to repeat it instead of enqueueing.
If the request is the same as the active task or a queued task, do NOT enqueue it again; say it is already in progress or queued.
Never speak task ids. Refer to tasks by what they do.
No filler: do not restate the question, do not say what Codex is "preparing" or "about to" do unless an event says so, do not add status the user did not ask for. If you have nothing factual to add, say so in one sentence.
If the latest user message is a notification relay (starts with [notification]), speak its content once, trimmed to the essentials, and nothing else.
When the user asks what was done or whether something is finished, answer from "Recent results" and the finished-tasks list; those are authoritative. Say "tests" only if a test command was actually run.`;

export async function converse(messages: ChatMessage[], state: AppState, memory: string[] = [], vocabulary: string[] = []): Promise<ConversationReply> {
  const history = messages
    .filter(m => m.role !== 'system')
    .slice(-12)
    .map(m => `${m.role === 'user' ? 'User' : 'VoiceCode'}: ${m.content}`)
    .join('\n');
  const notes = memory.slice(-8).map(n => `- ${n}`).join('\n');
  const vocab = vocabulary.slice(0, 60).join(', ');
  const prompt = `${RULES}\n\n=== CURRENT STATE ===\n${describeState(state)}${vocab ? `\n\n=== PROJECT VOCABULARY (from the codebase) ===\n${vocab}` : ''}${notes ? `\n\n=== NOTES FROM THE CODING AGENT'S WORK ===\n${notes}` : ''}\n\n=== CONVERSATION ===\n${history}\n\nRespond with the JSON object only.`;
  const { text, ms, model } = await gemma(prompt, { json: true, maxTokens: 400 });
  const parsed = parseJsonObject<Partial<ConversationReply>>(text);
  if (!parsed || typeof parsed.speech !== 'string') {
    return { speech: text.slice(0, 300) || "Sorry, I didn't catch that.", actions: [] };
  }
  const actions = Array.isArray(parsed.actions) ? (parsed.actions.filter(a => a && typeof a.type === 'string') as Action[]) : [];
  console.log(`[gemma] ${model} ${ms}ms actions=${actions.map(a => a.type).join(',') || 'none'}`);
  return { speech: parsed.speech, actions };
}
