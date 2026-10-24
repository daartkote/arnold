import { useEffect, useRef } from 'react';
import type { TranscriptEntry } from '../../shared/types';

const label: Record<TranscriptEntry['kind'], string> = {
  user: 'you',
  gemma: 'gemma → voice',
  codex_prompt: 'gemma → codex',
  analyst: 'analyst',
  notification: 'notify',
  system: 'system',
};

function fmt(ts: number) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

export default function ConversationLog({ entries }: { entries: TranscriptEntry[] }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: 'nearest' });
  }, [entries.length]);

  return (
    <div className="card log">
      <div className="label">Conversation log <span className="count">{entries.length}</span></div>
      {entries.length === 0 && <div className="empty"><span>💬</span>Nothing yet. Everything Gemma hears, says and sends to Codex lands here.</div>}
      <ul className="translog">
        {entries.slice(-80).map(e => {
          const actions = (e.meta?.actions as { type: string }[] | undefined)?.map(a => a.type).filter(t => t !== 'get_status');
          return (
            <li key={e.id} className={e.kind}>
              <span className="muted mono">{fmt(e.ts)}</span>
              <span className={`pill who-${e.kind}`}>{label[e.kind]}</span>
              <span className="grow">
                {e.text}
                {actions && actions.length > 0 && <span className="actions"> · {actions.join(', ')}</span>}
              </span>
            </li>
          );
        })}
        <div ref={end} />
      </ul>
    </div>
  );
}
