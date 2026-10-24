import { useEffect, useState, type ReactNode } from 'react';

interface Settings {
  speculativeTurn: boolean;
  turnTimeout: number;
  dryRun: boolean;
}

export default function VoiceSettings({ children }: { children?: ReactNode }) {
  const [s, setS] = useState<Settings | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [timeout, setTimeoutLocal] = useState(10);

  useEffect(() => {
    fetch('/api/settings').then(r => r.json()).then(v => { setS(v); setTimeoutLocal(v.turnTimeout); }).catch(() => {});
  }, []);

  const update = async (patch: Partial<Settings>) => {
    setBusy(true);
    setErr(null);
    try {
      const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      const v = await r.json();
      if (!r.ok) setErr(v.error ?? 'failed');
      setS(v.settings ?? v);
      setTimeoutLocal((v.settings ?? v).turnTimeout);
    } finally {
      setBusy(false);
    }
  };

  if (!s) return <div className="settings">{children}</div>;

  return (
    <div className="settings">
      {children}
      <label className="tog" title="Execute no actions; the agent only says what it would do">
        <input type="checkbox" checked={s.dryRun} disabled={busy} onChange={e => update({ dryRun: e.target.checked })} /><span className="switch" /> Dry run
      </label>
      <label className="tog" title="ElevenLabs sends the transcript to the LLM before the turn is confirmed; faster, but produces duplicate requests">
        <input type="checkbox" checked={s.speculativeTurn} disabled={busy} onChange={e => update({ speculativeTurn: e.target.checked })} /><span className="switch" /> Speculative turn
      </label>
      <label className="tog range" title="Seconds of silence before ElevenLabs nudges the conversation; off = agent never speaks unprompted">
        Nudge <span className="mono muted">{timeout < 0 ? 'off' : `${timeout}s`}</span>
        <input type="range" min={0} max={20} step={1} value={timeout < 0 ? 0 : timeout} disabled={busy}
          onChange={e => setTimeoutLocal(Number(e.target.value) === 0 ? -1 : Number(e.target.value))}
          onMouseUp={() => update({ turnTimeout: timeout })}
          onTouchEnd={() => update({ turnTimeout: timeout })}
          onKeyUp={() => update({ turnTimeout: timeout })} />
      </label>
      {err && <span className="error">{err}</span>}
    </div>
  );
}
