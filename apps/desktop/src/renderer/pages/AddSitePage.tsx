import { useState, type FormEvent, type ReactElement } from "react";
import { Link, useNavigate } from "react-router-dom";

type SiteEnvironment = "production" | "staging" | "development";

export function AddSitePage(): ReactElement {
  const navigate = useNavigate();
  const [baseUrl, setBaseUrl] = useState("");
  const [siteName, setSiteName] = useState("");
  const [registrationCode, setRegistrationCode] = useState("");
  const [wordpressUsername, setWordpressUsername] = useState("");
  const [environment, setEnvironment] =
    useState<SiteEnvironment>("development");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(event: FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    setBusy(true);
    setError(null);

    const res = await window.sitePilotDesktop.registerSite({
      baseUrl: baseUrl.trim(),
      registrationCode: registrationCode.trim(),
      siteName: siteName.trim(),
      environment,
      ...(wordpressUsername.trim().length > 0
        ? { wordpressUsername: wordpressUsername.trim() }
        : {})
    });

    setBusy(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }

    navigate(`/site/${res.site.id}/overview`);
  }

  return (
    <main className="app-shell home-shell">
      <article className="panel-card add-site-card">
        <p className="eyebrow">SitePilot</p>
        <h1>Add Site</h1>
        <p className="lede">
          Paste the WordPress site URL and one-time registration code from the
          SitePilot plugin screen. HTTPS is required.
        </p>
        <form className="config-form add-site-form" onSubmit={onSubmit}>
          <fieldset className="config-fieldset">
            <legend>Connection</legend>
            <label className="field">
              <span>Site base URL</span>
              <input
                type="url"
                placeholder="https://example.com"
                value={baseUrl}
                onChange={(event) => {
                  setBaseUrl(event.target.value);
                }}
                required
              />
            </label>
            <label className="field">
              <span>Registration code</span>
              <textarea
                rows={3}
                placeholder="Paste the one-time code from the plugin screen"
                value={registrationCode}
                onChange={(event) => {
                  setRegistrationCode(event.target.value);
                }}
                required
              />
            </label>
          </fieldset>

          <fieldset className="config-fieldset">
            <legend>Site details</legend>
            <label className="field">
              <span>Site name</span>
              <input
                type="text"
                placeholder="My WordPress site"
                value={siteName}
                onChange={(event) => {
                  setSiteName(event.target.value);
                }}
                required
              />
            </label>
            <label className="field">
              <span>Environment</span>
              <select
                value={environment}
                onChange={(event) => {
                  setEnvironment(event.target.value as SiteEnvironment);
                }}
              >
                <option value="development">Development</option>
                <option value="staging">Staging</option>
                <option value="production">Production</option>
              </select>
            </label>
            <label className="field">
              <span>WordPress username (optional)</span>
              <input
                type="text"
                placeholder="Used for MCP requests when required"
                value={wordpressUsername}
                onChange={(event) => {
                  setWordpressUsername(event.target.value);
                }}
              />
            </label>
          </fieldset>

          {error ? <p className="workspace-error">{error}</p> : null}

          <div className="action-row">
            <button type="submit" className="btn btn-primary" disabled={busy}>
              {busy ? "Registering…" : "Add site"}
            </button>
            <Link className="btn btn-secondary" to="/">
              Cancel
            </Link>
          </div>
        </form>
      </article>
    </main>
  );
}
