/**
 * Runs a named set of v2 E2E scripts one after another and prints a summary.
 *
 *   npm run test:e2e:smoke    onboarding and the desktop chat flow
 *   npm run test:e2e:content  smoke, plus the v2 engine suite and the MCP loop
 *   npm run test:e2e:all      content, plus publish/unpublish, Yoast SEO, ACF
 *                             blocks and a real-model long post
 *
 * A script whose site or key isn't configured is skipped with the reason, not
 * failed. Every script runs even if an earlier one fails, and the run exits
 * non-zero if any failed.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { E2E_ACF_SITE, E2E_OPENAI_API_KEY, E2E_WP_PATH } from "./config.js";

type Step = {
  script: string;
  /** Returns why the step can't run here, or null when it can. */
  skipReason?: () => string | null;
  env?: () => Record<string, string>;
};

const onboarding: Step = { script: "v2-onboarding" };
const chat: Step = { script: "v2-chat" };
const engine: Step = { script: "v2-gutenberg" };
const mcp: Step = { script: "v2-mcp" };
const status: Step = {
  script: "v2-status",
  skipReason: () => (E2E_WP_PATH ? null : "set SITEPILOT_E2E_WP_PATH or wpPath in .sitepilot-e2e.local.json"),
  env: () => ({ SITEPILOT_E2E_WP_PATH: E2E_WP_PATH ?? "" })
};
const seo: Step = {
  script: "v2-seo",
  skipReason: status.skipReason,
  env: status.env
};
const acf: Step = {
  script: "v2-acf",
  skipReason: () =>
    E2E_ACF_SITE.baseUrl && E2E_ACF_SITE.adminUsername && E2E_ACF_SITE.registrationCode
      ? null
      : "set SITEPILOT_E2E_ACF_BASE_URL, _ADMIN_USERNAME and _REGISTRATION_CODE, or acf in .sitepilot-e2e.local.json",
  env: () => ({
    SITEPILOT_E2E_BASE_URL: E2E_ACF_SITE.baseUrl ?? "",
    SITEPILOT_E2E_ADMIN_USERNAME: E2E_ACF_SITE.adminUsername ?? "",
    SITEPILOT_E2E_REGISTRATION_CODE: E2E_ACF_SITE.registrationCode ?? "",
    ...(E2E_ACF_SITE.adminPassword
      ? { SITEPILOT_E2E_ADMIN_PASSWORD: E2E_ACF_SITE.adminPassword }
      : {})
  })
};
const longPost: Step = {
  script: "v2-long-post",
  skipReason: () =>
    E2E_OPENAI_API_KEY ? null : "set OPENAI_API_KEY or openAiApiKey in .sitepilot-e2e.local.json"
};

const SUITES: Record<string, Step[]> = {
  smoke: [onboarding, chat],
  content: [onboarding, chat, engine, mcp],
  all: [onboarding, chat, engine, mcp, status, seo, acf, longPost]
};

type Outcome = { script: string; result: "passed" | "failed" | "skipped"; detail?: string };

function parseSuiteName(): string {
  const suiteName = process.argv[2];
  if (!suiteName || !(suiteName in SUITES)) {
    throw new Error(
      `Unknown or missing E2E suite. Use one of: ${Object.keys(SUITES).join(", ")}.`
    );
  }
  return suiteName;
}

function runScript(step: Step): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), `tests/e2e/${step.script}.ts`],
      {
        stdio: "inherit",
        env: { ...process.env, ...(step.env?.() ?? {}) }
      }
    );
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  });
}

async function main(): Promise<void> {
  const suiteName = parseSuiteName();
  const outcomes: Outcome[] = [];

  for (const step of SUITES[suiteName]) {
    const reason = step.skipReason?.() ?? null;
    if (reason) {
      console.log(`\n=== ${step.script}: skipped (${reason})`);
      outcomes.push({ script: step.script, result: "skipped", detail: reason });
      continue;
    }
    console.log(`\n=== ${step.script}`);
    const code = await runScript(step);
    outcomes.push(
      code === 0
        ? { script: step.script, result: "passed" }
        : { script: step.script, result: "failed", detail: `exit code ${code}` }
    );
  }

  console.log(`\n=== ${suiteName} suite summary`);
  for (const outcome of outcomes) {
    console.log(
      `${outcome.result.padEnd(7)} ${outcome.script}${outcome.detail ? ` (${outcome.detail})` : ""}`
    );
  }
  if (outcomes.some((outcome) => outcome.result === "failed")) {
    process.exitCode = 1;
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
