import { useCallback, useEffect, useState, type ReactElement } from "react";

import type { IpcResponse, ipcChannels } from "@sitepilot/contracts";

type McpState = Extract<
  IpcResponse<typeof ipcChannels.mcpServerGetState>,
  { ok: true }
>["state"];

function setupSnippets(url: string, token: string) {
  return {
    claudeCode: `claude mcp add --transport http sitepilot ${url} --header "Authorization: Bearer ${token}"`,
    codex: [
      "# ~/.codex/config.toml",
      "[mcp_servers.sitepilot]",
      `url = "${url}"`,
      'bearer_token_env_var = "SITEPILOT_MCP_TOKEN"',
      "",
      "# then, in the shell that runs codex:",
      `export SITEPILOT_MCP_TOKEN="${token}"`
    ].join("\n"),
    claudeDesktop: JSON.stringify(
      {
        mcpServers: {
          sitepilot: {
            command: "npx",
            args: [
              "-y",
              "mcp-remote",
              url,
              "--header",
              `Authorization: Bearer ${token}`
            ]
          }
        }
      },
      null,
      2
    )
  };
}

/**
 * Lets Claude Code, Claude Desktop and Codex on this Mac use SitePilot through
 * a local MCP server. Clients can look things up and prepare requests; a
 * person still approves every change here.
 */
export function McpServerSettings(): ReactElement {
  const [state, setState] = useState<McpState | null>(null);
  const [port, setPort] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);

  const apply = useCallback((next: McpState) => {
    setState(next);
    setPort(String(next.port));
  }, []);

  useEffect(() => {
    void window.sitePilotDesktop.getMcpServerState().then((res) => {
      if (res.ok) apply(res.state);
      else setErr(res.message);
    });
  }, [apply]);

  async function save(enabled: boolean): Promise<void> {
    if (!state) return;
    const parsedPort = Number(port);
    if (
      !Number.isInteger(parsedPort) ||
      parsedPort < 1024 ||
      parsedPort > 65_535
    ) {
      setErr("Choose a port between 1024 and 65535.");
      return;
    }
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.saveMcpServerSettings({
      enabled,
      port: parsedPort,
      siteScope: state.siteScope
    });
    setBusy(false);
    if (res.ok) apply(res.state);
    else setErr(res.message);
  }

  async function regenerate(): Promise<void> {
    setBusy(true);
    setErr(null);
    const res = await window.sitePilotDesktop.regenerateMcpServerToken();
    setBusy(false);
    if (res.ok) apply(res.state);
    else setErr(res.message);
  }

  async function copy(label: string, text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(label);
      setTimeout(() => setCopied(null), 2_000);
    } catch {
      setErr("Could not copy to the clipboard.");
    }
  }

  if (!state) {
    return (
      <section className="panel-card settings-card settings-card-wide">
        <h2>MCP server</h2>
        {err ? (
          <p className="workspace-error">{err}</p>
        ) : (
          <p className="muted">Loading…</p>
        )}
      </section>
    );
  }

  const url = state.url ?? `http://127.0.0.1:${state.port}/mcp`;
  const snippets = setupSnippets(url, state.token);
  const maskedToken = `${state.token.slice(0, 10)}${"•".repeat(16)}`;

  return (
    <section className="panel-card settings-card settings-card-wide">
      <h2>MCP server</h2>
      <p className="muted">
        Lets Claude Code, Claude Desktop and Codex on this Mac look things up
        and prepare requests through SitePilot. They cannot approve, apply or
        publish anything: every change still waits for you here.
      </p>
      {err ? <p className="workspace-error">{err}</p> : null}
      {state.error ? <p className="workspace-error">{state.error}</p> : null}

      <label className="settings-field settings-checkbox">
        <input
          type="checkbox"
          className="settings-checkbox-input"
          checked={state.enabled}
          disabled={busy}
          onChange={(e) => void save(e.target.checked)}
        />
        <span>
          Run the MCP server{" "}
          {state.running ? (
            <span className="muted">· running at {state.url}</span>
          ) : (
            <span className="muted">· off</span>
          )}
        </span>
      </label>

      <label className="settings-field">
        <span>Port (localhost only)</span>
        <input
          type="number"
          className="settings-input"
          min={1024}
          max={65535}
          value={port}
          disabled={busy}
          onChange={(e) => setPort(e.target.value)}
          onBlur={() => {
            if (port !== String(state.port)) void save(state.enabled);
          }}
        />
      </label>

      <div className="settings-field">
        <span>Access token</span>
        <code className="small-print">
          {showToken ? state.token : maskedToken}
        </code>
        <div className="settings-actions">
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => setShowToken((value) => !value)}
          >
            {showToken ? "Hide" : "Show"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            onClick={() => void copy("token", state.token)}
          >
            {copied === "token" ? "Copied" : "Copy"}
          </button>
          <button
            type="button"
            className="btn btn-secondary btn-small"
            disabled={busy}
            onClick={() => void regenerate()}
          >
            New token
          </button>
        </div>
        <p className="muted small-print">
          A new token disconnects every client until you update it there.
        </p>
      </div>

      {(
        [
          [
            "claudeCode",
            "Claude Code (run once in a terminal)",
            snippets.claudeCode
          ],
          ["codex", "Codex", snippets.codex],
          [
            "claudeDesktop",
            "Claude Desktop (claude_desktop_config.json, needs Node)",
            snippets.claudeDesktop
          ]
        ] as const
      ).map(([key, label, text]) => (
        <div className="settings-field" key={key}>
          <span>{label}</span>
          <pre className="small-print">
            {showToken ? text : text.replaceAll(state.token, maskedToken)}
          </pre>
          <div className="settings-actions">
            <button
              type="button"
              className="btn btn-secondary btn-small"
              onClick={() => void copy(key, text)}
            >
              {copied === key ? "Copied" : "Copy"}
            </button>
          </div>
        </div>
      ))}
    </section>
  );
}
