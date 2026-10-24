import { useEffect, useState } from 'react';
import VoicePanel from './VoicePanel';
import ConversationLog from './ConversationLog';
import DemoScript from './DemoScript';
import Preview from './Preview';
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
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  useEffect(() => {
    if (agentId) return;
    let cancelled = false;
    const load = () =>
      fetch('/api/config')
        .then(r => r.json())
        .then(c => { if (cancelled) return; setPreviewUrl(c.previewUrl ?? null); if (c.agentId) setAgentId(c.agentId); else setTimeout(load, 1500); })
        .catch(() => { if (!cancelled) setTimeout(load, 1500); });
    load();
    return () => { cancelled = true; };
  }, [agentId, connected]);

  if (!state) return <div className="shell"><p className="muted">Connecting…</p></div>;

  const active = state.tasks.find(t => t.id === state.activeTaskId);
  const queued = state.tasks.filter(t => t.status === 'queued');
  const history = state.tasks.filter(t => !['queued', 'running', 'cancelling'].includes(t.status)).slice(-8).reverse();
  const canStop = Boolean(active) || !state.paused;
  const finishedCount = state.tasks.filter(t => t.finishedAt).length;

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
        <div className="brand">
          <div className="logo"><div><span style={{ height: 10 }} /><span style={{ height: 18 }} /><span style={{ height: 13 }} /><span style={{ height: 7 }} /></div></div>
          <div>
            <h1>VoiceCode</h1>
            <div className="meta">
              provider <span className="chip">{state.provider}</span> · <span className="mono" title={state.projectDir}>{state.projectDir.split('/').slice(-1)[0]}</span>
              {state.threadId && <> · thread <span className="mono">{state.threadId.slice(0, 8)}</span></>}
            </div>
          </div>
        </div>
        <div className="controls">
          <span className="chip"><span className={`dot ${connected ? 'on' : 'off'}`} /> {connected ? 'Server online' : 'Server offline'}</span>
          {state.paused ? (
            <button className="primary" onClick={() => api.resume()}>▶ Resume queue</button>
          ) : (
            <button className="danger" onClick={() => api.stop()} disabled={!canStop}>■ Stop</button>
          )}
        </div>
      </header>

      <main>
        <section className="col">
          <DemoScript />
          <Preview url={previewUrl} reloadKey={finishedCount} />
        </section>

        <section className="col">
          <form onSubmit={submit} className="row">
            <input value={text} onChange={e => setText(e.target.value)} placeholder="Type a coding task or just say it…" />
            <button type="submit">Queue ↵</button>
          </form>

          <div className="card">
            <div className="label">Active task {active ? <span className={`status ${active.status}`}>{statusLabel[active.status]}</span> : <span className="status">{state.paused ? 'Paused' : 'Idle'}</span>}</div>
            {active ? (
              <>
                <p className="task-text">{active.text}</p>
                <p className="muted">started {active.startedAt ? fmt(active.startedAt) : ''}</p>
              </>
            ) : (
              <div className="empty"><span>⚡</span>{state.paused ? 'Queue paused. Press Resume to continue.' : 'No task running. Say or type something to start.'}</div>
            )}
          </div>

          <div className="card">
            <div className="label">Queue <span className="count">{queued.length}</span></div>
            {queued.length === 0 && <div className="empty"><span>☰</span>Nothing queued</div>}
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
            <div className="label">History <span className="count">{history.length}</span></div>
            {history.length === 0 && <div className="empty"><span>✓</span>No finished tasks yet</div>}
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
              {state.events.length === 0 && <li><span className="mono">{fmt(Date.now())}</span><span>waiting for events…</span></li>}
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
