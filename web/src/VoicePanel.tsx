import { useConversation } from '@elevenlabs/react';
import { useEffect, useRef, useState } from 'react';
import type { Notification } from '../../shared/types';
import { api } from './useAppState';
import VoiceSettings from './VoiceSettings';

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
  const [pushToTalk, setPushToTalk] = useState(true);
  const [holding, setHolding] = useState(false);
  const muted = connected && pushToTalk && !holding;

  const [iframeFocused, setIframeFocused] = useState(false);
  useEffect(() => {
    const onBlur = () => setTimeout(() => setIframeFocused(document.activeElement?.tagName === 'IFRAME'), 0);
    const onFocus = () => setIframeFocused(false);
    window.addEventListener('blur', onBlur);
    window.addEventListener('focus', onFocus);
    return () => { window.removeEventListener('blur', onBlur); window.removeEventListener('focus', onFocus); };
  }, []);

  const lastMuted = useRef<boolean | null>(null);
  useEffect(() => {
    if (!connected) { lastMuted.current = null; return; }
    try {
      conversation.setMuted(muted);
    } catch {}
    if (lastMuted.current !== muted) {
      lastMuted.current = muted;
      if (pushToTalk) push('system', muted ? 'mic off' : 'mic ON, speak now');
    }
  }, [muted, connected, conversation, pushToTalk]);

  useEffect(() => {
    if (!connected || !pushToTalk) return;
    const isTyping = (e: KeyboardEvent) => ['INPUT', 'TEXTAREA'].includes((e.target as HTMLElement)?.tagName);
    const down = (e: KeyboardEvent) => { if (e.code === 'Space' && !isTyping(e)) { e.preventDefault(); setHolding(true); } };
    const up = (e: KeyboardEvent) => { if (e.code === 'Space' && !isTyping(e)) { e.preventDefault(); setHolding(false); } };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    return () => { window.removeEventListener('keydown', down); window.removeEventListener('keyup', up); };
  }, [connected, pushToTalk]);

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
          <span className={`dot ${connected ? (conversation.isSpeaking ? 'speaking' : muted ? 'muted' : 'on') : 'off'}`} />
          <span className="muted">{connected ? (conversation.isSpeaking ? 'speaking' : muted ? 'mic off' : 'listening') : conversation.status}</span>
          {connected && (
            <label className="toggle muted">
              <input type="checkbox" checked={pushToTalk} onChange={e => setPushToTalk(e.target.checked)} /> push-to-talk
            </label>
          )}
          {connected ? (
            <button onClick={() => conversation.endSession()}>Hang up</button>
          ) : (
            <button className="primary" onClick={start} disabled={conversation.status === 'connecting'}>Start talking</button>
          )}
        </div>
      </div>
      <VoiceSettings />
      {error && <p className="error">{error}</p>}
      {connected && pushToTalk && iframeFocused && (
        <p className="error">The project preview has keyboard focus. Click here or hold the button below, Space will not work until you do.</p>
      )}
      {connected && pushToTalk && (
        <button
          className={`ptt ${holding ? 'active' : ''}`}
          onMouseDown={() => setHolding(true)}
          onMouseUp={() => setHolding(false)}
          onMouseLeave={() => setHolding(false)}
          onTouchStart={e => { e.preventDefault(); setHolding(true); }}
          onTouchEnd={() => setHolding(false)}
        >
          {holding ? 'Listening… release to send' : 'Hold to talk (or hold Space)'}
        </button>
      )}
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
