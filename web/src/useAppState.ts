import { useEffect, useRef, useState } from 'react';
import type { AgentEvent, AppState, Notification, ServerMessage } from '../../shared/types';

export function useAppState(onNotification?: (n: Notification) => void) {
  const [state, setState] = useState<AppState | null>(null);
  const [connected, setConnected] = useState(false);
  const handler = useRef(onNotification);
  handler.current = onNotification;

  useEffect(() => {
    let ws: WebSocket;
    let closed = false;
    const connect = () => {
      const proto = location.protocol === 'https:' ? 'wss' : 'ws';
      ws = new WebSocket(`${proto}://${location.host}/ws`);
      ws.onopen = () => setConnected(true);
      ws.onclose = () => {
        setConnected(false);
        if (!closed) setTimeout(connect, 1000);
      };
      ws.onmessage = ev => {
        const msg = JSON.parse(ev.data) as ServerMessage;
        if (msg.type === 'state') setState(msg.state);
        if (msg.type === 'event') setState(s => (s ? { ...s, events: [...s.events, msg.event].slice(-200) } : s));
        if (msg.type === 'notification') handler.current?.(msg.notification);
      };
    };
    connect();
    return () => {
      closed = true;
      ws.close();
    };
  }, []);

  return { state, connected };
}

export const api = {
  enqueue: (text: string) => fetch('/api/tasks', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, source: 'ui' }) }),
  cancel: (id: string) => fetch(`/api/tasks/${id}`, { method: 'DELETE' }),
  stop: () => fetch('/api/stop', { method: 'POST' }),
  resume: () => fetch('/api/resume', { method: 'POST' }),
  research: (question: string) => fetch('/api/research', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ question }) }),
  ack: (id: string) => fetch(`/api/notifications/${id}/ack`, { method: 'POST' }),
};

export type { AgentEvent };
