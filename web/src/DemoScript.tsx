import { useEffect, useState } from 'react';

interface Step {
  title: string;
  say?: string;
  expect: string;
  action?: string;
}

const STEPS: Step[] = [
  { title: 'Warm-up', say: 'What are you working on right now?', expect: 'Queue is empty, nothing running.' },
  { title: 'Long task', say: 'Add tags to tasks. A task can have several tags, show them as chips, and let me filter the list by tag. Make sure the build passes.', expect: 'Task appears in queue as voice. Codex events start flowing.' },
  { title: 'By the way', say: 'By the way, how are tasks stored in this project?', expect: '“Let me look that up”, then a spoken answer about localStorage ~15 s later. Codex keeps working.' },
  { title: 'Queue second task', say: 'Next, add an optional due date to each task and highlight overdue tasks in red.', expect: 'Queued behind tags. Two items in the queue.' },
  { title: 'Honesty check', say: "What did you decide about tasks that don't have a due date?", expect: 'Agent admits the task is still queued and not started.' },
  { title: 'Completion', expect: 'Say nothing. Agent announces tags are done and whether the build passed. Preview reloads; add a task with a tag.' },
  { title: 'Stop', action: 'Press Stop once due-date commands start.', say: 'What happened to the due date task?', expect: 'Interrupted, queue paused, pending tasks preserved.' },
  { title: 'Resume + finale', action: 'Press Resume queue.', say: 'Add dark mode with a toggle button and remember my choice.', expect: 'Runs about a minute; agent announces completion, toggle theme in the preview.' },
  { title: 'Wrap-up', say: 'Give me a summary of what we did today.', expect: 'Tags done, due dates interrupted, dark mode done.' },
];

export default function DemoScript() {
  const [current, setCurrent] = useState(() => {
    try { return Number(localStorage.getItem('voicecode.demoStep') ?? 0); } catch { return 0; }
  });
  useEffect(() => {
    try { localStorage.setItem('voicecode.demoStep', String(current)); } catch {}
  }, [current]);

  return (
    <div className="card script">
      <div className="voice-head">
        <div className="label">Demo script</div>
        <button className="ghost" onClick={() => setCurrent(0)}>reset</button>
      </div>
      <ol className="steps">
        {STEPS.map((s, i) => (
          <li key={s.title} className={i === current ? 'current' : i < current ? 'done' : ''} onClick={() => setCurrent(i)}>
            <div className="step-title">{i + 1}. {s.title}</div>
            {s.action && <div className="step-action">{s.action}</div>}
            {s.say && <div className="step-say">“{s.say}”</div>}
            <div className="muted step-expect">{s.expect}</div>
          </li>
        ))}
      </ol>
    </div>
  );
}
