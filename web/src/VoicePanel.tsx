import { useConversation } from '@elevenlabs/react';
import { useEffect, useRef, useState } from 'react';
import type { Notification } from '../../shared/types';
import VoiceSettings from './VoiceSettings';

interface Props {
  agentId: string | null;
  pending: Notification[];
}

export default function VoicePanel({ agentId, pending }: Props) {
  const [error, setError] = useState<string | null>(null);
  const sentAt = useRef(new Map<string, number>());
  const RESEND_MS = 12000;

  const conversation = useConversation({
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

  useEffect(() => {
    if (!connected) return;
    try {
      conversation.setMuted(muted);
    } catch {}
  }, [muted, connected, conversation]);

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
    if (!connected || holding || conversation.isSpeaking) return;
    const tick = () => {
      if (holding || conversation.isSpeaking) return;
      const now = Date.now();
      const next = pending.find(n => now - (sentAt.current.get(n.id) ?? 0) > RESEND_MS);
      if (!next) return;
      sentAt.current.set(next.id, now);
      conversation.sendUserMessage(`[notification] ${next.text}`);
    };
    tick();
    const timer = setInterval(tick, 3000);
    return () => clearInterval(timer);
  }, [pending, connected, conversation, holding, conversation.isSpeaking]);

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
        <span className="chip">
          <span className={`dot ${connected ? (conversation.isSpeaking ? 'speaking' : muted ? 'muted' : 'on') : 'off'}`} />
          {connected ? (conversation.isSpeaking ? 'speaking' : muted ? 'mic off' : 'listening') : conversation.status}
        </span>
      </div>
      <div className="voice-top">
        <button
          className={`mic ${connected ? (muted ? 'live' : 'hot') : ''}`}
          onClick={connected ? () => conversation.endSession() : start}
          disabled={conversation.status === 'connecting'}
          title={connected ? 'Hang up' : 'Start talking'}
        >
          {connected ? (
            <svg viewBox="0 0 24 24"><path d="M6 6h12v12H6z" /></svg>
          ) : (
            <svg viewBox="0 0 24 24"><path d="M12 14a3 3 0 0 0 3-3V5a3 3 0 1 0-6 0v6a3 3 0 0 0 3 3Zm5-3a5 5 0 0 1-10 0H5a7 7 0 0 0 6 6.92V21h2v-3.08A7 7 0 0 0 19 11h-2Z" /></svg>
          )}
        </button>
        <div className="voice-info">
          <h2>{connected ? (muted ? 'Connected, mic off' : conversation.isSpeaking ? 'VoiceCode is speaking' : 'Listening…') : 'Start talking'}</h2>
          <p>{connected ? (pushToTalk ? 'Hold Space or the button below while you speak. Tap the circle to hang up.' : 'Open mic. Tap the circle to hang up.') : 'Tap the mic and describe what you want to build.'}</p>
          <div className={`wave ${connected && !muted ? 'active' : ''}`}>
            {[6, 12, 20, 9, 16, 24, 11, 6, 14, 20, 8, 12, 5].map((h, i) => <i key={i} style={{ height: h }} />)}
          </div>
        </div>
      </div>
      <VoiceSettings />
      {connected && (
        <div className="settings" style={{ marginTop: 10, paddingTop: 0, borderTop: 0 }}>
          <label className="tog">
            <input type="checkbox" checked={pushToTalk} onChange={e => setPushToTalk(e.target.checked)} /><span className="switch" /> Push-to-talk
          </label>
        </div>
      )}
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
      {!connected && <p className="hint">Try: <q>add a search box to the tasks</q> or <q>by the way, how are tasks stored?</q></p>}
    </div>
  );
}
