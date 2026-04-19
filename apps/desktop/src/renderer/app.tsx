import { useEffect, useState } from "react";

import "./styles.css";

export function App(): JSX.Element {
  const [shellInfo, setShellInfo] = useState<{
    appName: string;
    appVersion: string;
    rendererVersion: string;
  } | null>(null);

  useEffect(() => {
    let cancelled = false;

    void window.sitePilotDesktop.getShellInfo().then((response) => {
      if (!cancelled) {
        setShellInfo(response);
      }
    });

    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <main className="app-shell">
      <section className="hero-card">
        <p className="eyebrow">Desktop Control Plane</p>
        <h1>SitePilot</h1>
        <p className="lede">
          Local-first orchestration for WordPress site management with a secure
          Electron shell.
        </p>
      </section>

      <section className="status-grid">
        <article className="status-card">
          <h2>Renderer</h2>
          <p>{shellInfo?.rendererVersion ?? "Loading..."}</p>
        </article>
        <article className="status-card">
          <h2>Bridge</h2>
          <p>
            Typed preload API exposed with context isolation enabled and
            request/response validation on both sides.
          </p>
        </article>
        <article className="status-card">
          <h2>Privilege Model</h2>
          <p>Node integration disabled and renderer sandbox enabled.</p>
        </article>
        <article className="status-card">
          <h2>App Version</h2>
          <p>{shellInfo?.appVersion ?? "Loading..."}</p>
        </article>
      </section>
    </main>
  );
}
