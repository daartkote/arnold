import { useEffect, useState } from 'react';
import VoicePanel from './VoicePanel';
import ConversationLog from './ConversationLog';
import type { Task } from '../../shared/types';
import { api, useAppState } from './useAppState';

const statusLabel: Record<Task['status'], string> = {
  queued: 'Queued',
  running: 'Running',
  cancelling: 'Cancelling…',
  done: 'Done',
  failed: 'Failed',
  interrupted: 'Interrupted',
  cancelled: 'Cancelled',
};

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function App() {
  const { state, connected } = useAppState();
  const [text, setText] = useState('');
  const [question, setQuestion] = useState('');
  const [agentId, setAgentId] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/config').then(r => r.json()).then(c => setAgentId(c.agentId)).catch(() => {});
  }, []);

  if (!state) return <div className="shell"><p className="muted">Connecting…</p></div>;

  const active = state.tasks.find(t => t.id === state.activeTaskId);
  const queued = state.tasks.filter(t => t.status === 'queued');
  const history = state.tasks.filter(t => !['queued', 'running', 'cancelling'].includes(t.status)).slice(-8).reverse();
  const canStop = Boolean(active) || !state.paused;

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!text.trim()) return;
    api.enqueue(text.trim());
    setText('');
  };

  const ask = (e: React.FormEvent) => {
    e.preventDefault();
    if (!question.trim()) return;
    api.research(question.trim());
    setQuestion('');
  };

  return (
    <div className="shell">
      <header>
        <div>
          <h1>VoiceCode</h1>
          <p className="muted">
            provider <b>{state.provider}</b> · <span title={state.projectDir}>{state.projectDir.split('/').slice(-1)[0]}</span>
            {state.threadId && <> · thread <code>{state.threadId.slice(0, 8)}</code></>}
          </p>
        </div>
        <div className="controls">
          <span className={`dot ${connected ? 'on' : 'off'}`} />
          {state.paused ? (
            <button className="primary" onClick={() => api.resume()}>Resume queue</button>
          ) : (
            <button className="danger" onClick={() => api.stop()} disabled={!canStop}>Stop</button>
          )}
        </div>
      </header>

      <main>
        <section className="col">
          <form onSubmit={submit} className="row">
            <input value={text} onChange={e => setText(e.target.value)} placeholder="Type a coding task or just say it…" />
            <button type="submit">Queue</button>
          </form>

          <div className="card active">
            <div className="label">Active task</div>
            {active ? (
              <>
                <div className={`status ${active.status}`}>{statusLabel[active.status]}</div>
                <p className="task-text">{active.text}</p>
                <p className="muted">started {active.startedAt ? fmt(active.startedAt) : ''}</p>
              </>
            ) : (
              <p className="muted">{state.paused ? 'Queue paused' : 'Idle'}</p>
            )}
          </div>

          <div className="card">
            <div className="label">Queue · {queued.length}</div>
            {queued.length === 0 && <p className="muted">Nothing queued</p>}
            <ul className="list">
              {queued.map((t, i) => (
                <li key={t.id}>
                  <span className="idx">{i + 1}</span>
                  <span className="grow">{t.text}</span>
                  <span className="pill">{t.source}</span>
                  <button className="ghost" onClick={() => api.cancel(t.id)}>✕</button>
                </li>
              ))}
            </ul>
          </div>

          <div className="card">
            <div className="label">History</div>
            {history.length === 0 && <p className="muted">No finished tasks yet</p>}
            <ul className="list">
              {history.map(t => (
                <li key={t.id} className="history">
                  <span className={`status small ${t.status}`}>{statusLabel[t.status]}</span>
                  <span className="grow">
                    {t.text}
                    {t.summary && <div className="muted summary">{t.summary}</div>}
                  </span>
                  {t.commandsRun != null && <span className="pill">{t.commandsRun} cmd{t.commandsFailed ? ` · ${t.commandsFailed} failed` : ''}</span>}
                </li>
              ))}
            </ul>
          </div>
        </section>

        <section className="col">
          <VoicePanel agentId={agentId} pending={state.notifications} />
          <form onSubmit={ask} className="row">
            <input value={question} onChange={e => setQuestion(e.target.value)} placeholder="By the way… ask about the project (read-only)" />
            <button type="submit">Ask</button>
          </form>

          {state.research.length > 0 && (
            <div className="card">
              <div className="label">Research</div>
              <ul className="list">
                {state.research.slice(-3).reverse().map(r => (
                  <li key={r.id} className="history">
                    <span className={`status small ${r.status === 'running' ? 'running' : r.status === 'done' ? 'done' : 'failed'}`}>{r.status}</span>
                    <span className="grow">
                      {r.question}
                      {r.answer && <div className="muted summary">{r.answer}</div>}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}

          <ConversationLog entries={state.transcript} />

          <div className="card feed">
            <div className="label">Codex events</div>
            <ul className="events">
              {state.events.slice(-60).reverse().map(e => (
                <li key={e.id}>
                  <span className="muted mono">{fmt(e.ts)}</span>
                  <span className="pill mono">{e.type}</span>
                  <span className="grow mono">{e.summary}</span>
                </li>
              ))}
            </ul>
          </div>
        </section>
      </main>
    </div>
  );
}
