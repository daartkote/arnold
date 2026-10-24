import { useEffect, useRef, useState } from 'react';

export default function Preview({ url, reloadKey }: { url: string | null; reloadKey: number }) {
  const [nonce, setNonce] = useState(0);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    const t = setTimeout(() => setNonce(n => n + 1), 800);
    return () => clearTimeout(t);
  }, [reloadKey]);

  if (!url) return null;
  return (
    <div className="card preview">
      <div className="voice-head">
        <div className="label">Project preview</div>
        <div className="controls">
          <button className="ghost" onClick={() => setNonce(n => n + 1)}>reload</button>
          <a className="ghost-link" href={url} target="_blank" rel="noreferrer">open ↗</a>
        </div>
      </div>
      <iframe key={nonce} src={url} title="project preview" />
    </div>
  );
}
