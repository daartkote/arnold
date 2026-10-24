# VoiceCode

**Bring your own coding agent. Give it a voice.**

VoiceCode is a hands-free, English-language voice interface to a coding agent. You talk over a headset, the agent edits a real project, and VoiceCode tells you what actually happened — never more than the exit codes support.

```
Browser (React UI: mic, queue, Stop)
        │  audio
ElevenLabs Conversational Agent (STT, turn-taking, TTS)
        │  OpenAI-compatible Custom LLM call
Node server  /v1/chat/completions  →  Gemma (Gemini API) → typed actions
        │
Orchestrator: FIFO queue, one active run, Stop/Resume, event log
        │
AgentAdapter → CodexAdapter (`codex exec --json`)
        │
Raw JSONL events → Gemma event analyst → SKIP / REMEMBER / SPEAK → spoken updates
```

## What it does

- **Voice → code.** "Add a search box to the tasks" becomes a queued task; the coding agent runs it in the project directory, reusing one agent thread across tasks.
- **Visible queue.** Active task, queued tasks, history with command counts and failures, and a live event feed.
- **Deterministic Stop.** The Stop button goes straight to the server: it kills the whole agent process tree, marks the task `interrupted`, pauses the queue and keeps pending tasks. Resume is explicit.
- **Honest reporting.** Gemma only gets to say "build passed" if a `command_execution` event with exit code 0 says so.
- **Proactive updates.** Every agent event batch is reviewed by Gemma. Routine progress is skipped, useful facts are remembered, completions and blockers are spoken.
- **"By the way…" research.** Questions about the codebase run in a separate read-only agent process while the coding task continues.
- **Provider-agnostic.** The orchestrator, UI and prompts only know the `AgentAdapter` contract (`run`, `stop`, `research`). Codex is the first adapter.

## Run it

Requirements: Node 22, `codex` CLI logged in, `cloudflared`.

```
cp .env.example .env   # fill in keys
npm install
npm run dev            # server on :3000, UI on :5173
cloudflared tunnel --url http://localhost:3000
./scripts/set-agent-url.sh   # points the ElevenLabs agent at the tunnel
```

Open http://localhost:5173, press **Start talking**.

### Environment

| Variable | Purpose |
|---|---|
| `GEMINI_API_KEY` | Gemma via Google AI Studio (`gemma-4-26b-a4b-it`) |
| `ELEVENLABS_API_KEY` | Updating the agent's Custom LLM URL |
| `ELEVENLABS_AGENT_ID` | Agent the browser connects to |
| `CUSTOM_LLM_SECRET` | Header ElevenLabs must send to `/v1/chat/completions` |
| `PROJECT_DIR` | Directory the coding agent works in |
| `PROVIDER` | `codex` (default) or `fake` for UI development |

## Design notes

- Gemma never runs shell commands. It emits typed actions (`enqueue_task`, `cancel_queued_task`, `research_project`, `get_status`, `stop`, `resume`); the server validates and executes them.
- `turn.completed` from Codex means the turn ended, not that anything worked. Task status is derived from command exit codes.
- Killing the Codex process group is not enough: its shell commands run in their own process group. The adapter walks the descendant tree and kills every process, then waits for exit.
- Proactive speech is a *new user-role turn* (`sendUserMessage` with a `[notification]` prefix), so the conversation model phrases it; nothing is injected as system authority. Notifications are acknowledged once delivered to avoid repeats.
- Gemma 4 is run with `thinkingLevel: minimal`; without it, responses take 7–9 s and leak reasoning.

## Status

Verified end-to-end on macOS: voice → task → real file edits → spoken, truthful completion; Stop on a long-running command; resume after an interrupted turn; concurrent read-only research. Second adapters (OpenCode, Claude Code) are a natural extension of the `AgentAdapter` interface and not part of this submission.
