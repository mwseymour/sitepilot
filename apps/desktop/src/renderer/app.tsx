import "./styles.css";

export function App(): JSX.Element {
  const shellInfo = window.sitePilotDesktop.getShellInfo();

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
          <p>{shellInfo.rendererVersion}</p>
        </article>
        <article className="status-card">
          <h2>Bridge</h2>
          <p>Typed preload API exposed with context isolation enabled.</p>
        </article>
        <article className="status-card">
          <h2>Privilege Model</h2>
          <p>Node integration disabled and renderer sandbox enabled.</p>
        </article>
      </section>
    </main>
  );
}
