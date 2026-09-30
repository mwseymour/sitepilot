import { randomBytes } from "node:crypto";

import {
  createSitePilotMcpServer,
  startLocalMcpHttpServer,
  type LocalMcpHttpServer
} from "@sitepilot/mcp-server";

import { getSecureStorage } from "@sitepilot/core/app-secure-storage";
import { createDesktopMcpBackend } from "@sitepilot/core/mcp-backend";

export const DEFAULT_MCP_PORT = 8765;

export type McpServerSettings = {
  enabled: boolean;
  port: number;
  /** Sites MCP clients may use: every active site, or a chosen list. */
  siteScope: "all" | string[];
};

export type McpServerState = McpServerSettings & {
  running: boolean;
  url: string | null;
  token: string;
  error: string | null;
};

const SETTINGS_KEY = {
  namespace: "app",
  keyId: "mcp_server:settings"
} as const;
const TOKEN_KEY = { namespace: "app", keyId: "mcp_server:token" } as const;

const DEFAULT_SETTINGS: McpServerSettings = {
  enabled: false,
  port: DEFAULT_MCP_PORT,
  siteScope: "all"
};

let running: LocalMcpHttpServer | null = null;
let lastError: string | null = null;
let appVersion = "0.0.0";

function parseSettings(raw: string | undefined): McpServerSettings {
  if (!raw) return { ...DEFAULT_SETTINGS };
  try {
    const value = JSON.parse(raw) as Partial<McpServerSettings>;
    return {
      enabled: value.enabled === true,
      port:
        Number.isInteger(value.port) &&
        (value.port as number) >= 1024 &&
        (value.port as number) <= 65_535
          ? (value.port as number)
          : DEFAULT_MCP_PORT,
      siteScope: Array.isArray(value.siteScope)
        ? value.siteScope.filter((id): id is string => typeof id === "string")
        : "all"
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function generateMcpToken(): string {
  return `spmcp_${randomBytes(32).toString("base64url")}`;
}

async function loadToken(): Promise<string> {
  const storage = getSecureStorage();
  const existing = await storage.get(TOKEN_KEY);
  if (existing) return existing;
  const token = generateMcpToken();
  await storage.set(TOKEN_KEY, token);
  return token;
}

export async function loadMcpServerSettings(): Promise<McpServerSettings> {
  return parseSettings(await getSecureStorage().get(SETTINGS_KEY));
}

export async function getMcpServerState(): Promise<McpServerState> {
  const settings = await loadMcpServerSettings();
  return {
    ...settings,
    running: running !== null,
    url: running?.url ?? null,
    token: await loadToken(),
    error: lastError
  };
}

async function stop(): Promise<void> {
  const current = running;
  running = null;
  await current?.close();
}

async function start(settings: McpServerSettings): Promise<void> {
  await stop();
  lastError = null;
  if (!settings.enabled) return;
  const token = await loadToken();
  const backend = createDesktopMcpBackend({ siteScope: settings.siteScope });
  try {
    running = await startLocalMcpHttpServer({
      port: settings.port,
      token,
      createServer: () =>
        createSitePilotMcpServer({ backend, version: appVersion })
    });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    lastError =
      code === "EADDRINUSE"
        ? `Port ${settings.port} is already in use. Choose another port.`
        : error instanceof Error
          ? error.message
          : String(error);
  }
}

/** Start the server at app launch when it was left on. */
export async function startMcpServerIfEnabled(version: string): Promise<void> {
  appVersion = version;
  await start(await loadMcpServerSettings());
}

export async function saveMcpServerSettings(
  next: McpServerSettings
): Promise<McpServerState> {
  const settings = parseSettings(JSON.stringify(next));
  await getSecureStorage().set(SETTINGS_KEY, JSON.stringify(settings));
  await start(settings);
  return getMcpServerState();
}

/** A new token disconnects every client until it is updated. */
export async function regenerateMcpServerToken(): Promise<McpServerState> {
  await getSecureStorage().set(TOKEN_KEY, generateMcpToken());
  await start(await loadMcpServerSettings());
  return getMcpServerState();
}

export async function stopMcpServer(): Promise<void> {
  await stop();
}
