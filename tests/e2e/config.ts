import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

type LocalConfig = {
  baseUrl?: string;
  adminUsername?: string;
  adminPassword?: string;
  adminEmail?: string;
  registrationCode?: string;
  openAiApiKey?: string;
  anthropicApiKey?: string;
};

function loadLocalConfig(): LocalConfig {
  const filePath = join(process.cwd(), ".sitepilot-e2e.local.json");
  if (!existsSync(filePath)) {
    return {};
  }
  const raw = readFileSync(filePath, "utf8").trim();
  if (raw.length === 0) {
    return {};
  }
  try {
    return JSON.parse(raw) as LocalConfig;
  } catch (error) {
    throw new Error(
      `Failed to parse ${filePath}: ${error instanceof Error ? error.message : "unknown error"}`
    );
  }
}

const localConfig = loadLocalConfig();

export const E2E_BASE_URL =
  process.env.SITEPILOT_E2E_BASE_URL ??
  localConfig.baseUrl ??
  "https://test.localhost:8890/";
export const E2E_ADMIN_USERNAME =
  process.env.SITEPILOT_E2E_ADMIN_USERNAME ??
  localConfig.adminUsername ??
  "sitepilot_admin";
export const E2E_ADMIN_PASSWORD =
  process.env.SITEPILOT_E2E_ADMIN_PASSWORD ??
  localConfig.adminPassword ??
  "sitepilot_admin_password";
export const E2E_ADMIN_EMAIL =
  process.env.SITEPILOT_E2E_ADMIN_EMAIL ??
  localConfig.adminEmail ??
  "sitepilot-admin@example.com";
export const E2E_REGISTRATION_CODE =
  process.env.SITEPILOT_E2E_REGISTRATION_CODE ??
  localConfig.registrationCode ??
  "sitepilot-e2e-registration-code";
export const E2E_OPENAI_API_KEY =
  process.env.OPENAI_API_KEY ?? localConfig.openAiApiKey;
export const E2E_ANTHROPIC_API_KEY =
  process.env.ANTHROPIC_API_KEY ?? localConfig.anthropicApiKey;
export const E2E_ARTIFACTS_ROOT = join(
  process.cwd(),
  ".sitepilot-test-artifacts"
);
