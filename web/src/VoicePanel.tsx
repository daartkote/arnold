import { useConversation } from '@elevenlabs/react';
import { useEffect, useRef, useState } from 'react';
import type { Notification } from '../../shared/types';
import { api } from './useAppState';

interface Line {
  id: number;
  role: 'user' | 'agent' | 'system';
  text: string;
}

interface Props {
  agentId: string | null;
  pending: Notification[];
}

export default function VoicePanel({ agentId, pending }: Props) {
  const [lines, setLines] = useState<Line[]>([]);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const delivered = useRef(new Set<string>());

  const push = (role: Line['role'], text: string) => setLines(l => [...l, { id: seq.current++, role, text }].slice(-30));

  const conversation = useConversation({
    onConnect: () => push('system', 'connected'),
    onDisconnect: () => push('system', 'disconnected'),
    onMessage: (m: { source: string; message: string }) => push(m.source === 'user' ? 'user' : 'agent', m.message),
    onError: (e: unknown) => setError(typeof e === 'string' ? e : (e as Error)?.message ?? 'voice error'),
  });

  const connected = conversation.status === 'connected';

  useEffect(() => {
    if (!connected) return;
    for (const n of pending) {
      if (delivered.current.has(n.id)) continue;
      delivered.current.add(n.id);
      conversation.sendUserMessage(`[notification] ${n.text}`);
      push('system', `relayed: ${n.text}`);
      api.ack(n.id);
    }
  }, [pending, connected, conversation]);

  const start = async () => {
    if (!agentId) return setError('ELEVENLABS_AGENT_ID is not configured on the server');
    setError(null);
    try {
      await navigator.mediaDevices.getUserMedia({ audio: true });
      await conversation.startSession({ agentId, connectionType: 'webrtc' });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="card voice">
      <div className="voice-head">
        <div className="label">Voice</div>
        <div className="controls">
          <span className={`dot ${connected ? (conversation.isSpeaking ? 'speaking' : 'on') : 'off'}`} />
          <span className="muted">{connected ? (conversation.isSpeaking ? 'speaking' : 'listening') : conversation.status}</span>
          {connected ? (
            <button onClick={() => conversation.endSession()}>Hang up</button>
          ) : (
            <button className="primary" onClick={start} disabled={conversation.status === 'connecting'}>Start talking</button>
          )}
        </div>
      </div>
      {error && <p className="error">{error}</p>}
      <ul className="transcript">
        {lines.length === 0 && <li className="muted">Say something like “add a search box to the tasks” or “by the way, how are tasks stored?”</li>}
        {lines.map(l => (
          <li key={l.id} className={l.role}>
            <span className="who">{l.role === 'user' ? 'you' : l.role === 'agent' ? 'voicecode' : '·'}</span>
            <span>{l.text}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
