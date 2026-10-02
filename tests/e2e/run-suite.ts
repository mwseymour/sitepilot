/**
 * Runs a named set of v2 E2E scripts and prints a summary with each script's
 * time.
 *
 *   npm run test:e2e:smoke    onboarding and the desktop chat flow
 *   npm run test:e2e:content  smoke, plus the v2 engine suite and the MCP loop
 *   npm run test:e2e:all      content, plus publish/unpublish, Yoast SEO, ACF
 *                             blocks and the hosted server; the real-model
 *                             long post only with SITEPILOT_E2E_LONG_POST=1
 *
 * Scripts on the MAMP site run one after another, since they share its
 * registration codes. The ACF site's script runs alongside them. A script
 * whose site or key isn't configured is skipped with the reason, not failed.
 * Every script runs even if an earlier one fails, and the run exits non-zero
 * if any failed.
 */
import { spawn } from "node:child_process";
import { join } from "node:path";

import { E2E_ACF_SITE, E2E_OPENAI_API_KEY, E2E_WP_PATH } from "./config.js";

type Step = {
  script: string;
  /** Scripts on another site run alongside the MAMP ones. */
  parallel?: boolean;
  /** Returns why the step can't run here, or null when it can. */
  skipReason?: () => string | null;
  env?: () => Record<string, string>;
};

const onboarding: Step = { script: "v2-onboarding" };
const chat: Step = { script: "v2-chat" };
const engine: Step = { script: "v2-gutenberg" };
const mcp: Step = { script: "v2-mcp" };
const needsWpPath = (): string | null =>
  E2E_WP_PATH
    ? null
    : "set SITEPILOT_E2E_WP_PATH or wpPath in .sitepilot-e2e.local.json";
const wpPathEnv = (): Record<string, string> => ({
  SITEPILOT_E2E_WP_PATH: E2E_WP_PATH ?? ""
});
const status: Step = {
  script: "v2-status",
  skipReason: needsWpPath,
  env: wpPathEnv
};
const seo: Step = { script: "v2-seo", skipReason: needsWpPath, env: wpPathEnv };
const renderCheck: Step = {
  script: "v2-render-check",
  skipReason: needsWpPath,
  env: wpPathEnv
};
const acf: Step = {
  script: "v2-acf",
  parallel: true,
  skipReason: () =>
    E2E_ACF_SITE.baseUrl && E2E_ACF_SITE.adminUsername
      ? null
      : "set SITEPILOT_E2E_ACF_BASE_URL and _ADMIN_USERNAME (plus _WP_PATH, or _ADMIN_PASSWORD), or acf in .sitepilot-e2e.local.json",
  env: () => ({
    SITEPILOT_E2E_BASE_URL: E2E_ACF_SITE.baseUrl ?? "",
    SITEPILOT_E2E_ADMIN_USERNAME: E2E_ACF_SITE.adminUsername ?? "",
    // Each script reads a fresh registration code, so this must be the ACF
    // site's WordPress path, not the MAMP site's.
    SITEPILOT_E2E_WP_PATH: E2E_ACF_SITE.wpPath ?? "",
    ...(E2E_ACF_SITE.registrationCode
      ? { SITEPILOT_E2E_REGISTRATION_CODE: E2E_ACF_SITE.registrationCode }
      : {}),
    ...(E2E_ACF_SITE.adminPassword
      ? { SITEPILOT_E2E_ADMIN_PASSWORD: E2E_ACF_SITE.adminPassword }
      : {})
  })
};
const longPost: Step = {
  script: "v2-long-post",
  // Slow, and it pays for a real model call: run it when planning changes.
  skipReason: () =>
    process.env.SITEPILOT_E2E_LONG_POST !== "1"
      ? "opt-in: set SITEPILOT_E2E_LONG_POST=1 to run the real-model long post"
      : E2E_OPENAI_API_KEY
        ? null
        : "set OPENAI_API_KEY or openAiApiKey in .sitepilot-e2e.local.json"
};

const hosted: Step = {
  script: "hosted",
  skipReason: () =>
    !process.env.SITEPILOT_TEST_POSTGRES_URL
      ? "set SITEPILOT_TEST_POSTGRES_URL to the local test Postgres (docker start sitepilot-pg-test)"
      : !E2E_OPENAI_API_KEY
        ? "set OPENAI_API_KEY or openAiApiKey in .sitepilot-e2e.local.json"
        : needsWpPath(),
  env: wpPathEnv
};

const SUITES: Record<string, Step[]> = {
  smoke: [onboarding, chat],
  content: [onboarding, chat, engine, mcp, renderCheck],
  all: [onboarding, chat, engine, mcp, renderCheck, status, seo, acf, longPost, hosted]
};

type Outcome = {
  script: string;
  result: "passed" | "failed" | "skipped";
  detail?: string;
  seconds?: number;
};

function parseSuiteName(): string {
  const suiteName = process.argv[2];
  if (!suiteName || !(suiteName in SUITES)) {
    throw new Error(
      `Unknown or missing E2E suite. Use one of: ${Object.keys(SUITES).join(", ")}.`
    );
  }
  return suiteName;
}

/** Runs one script; a parallel one's output is held and printed when it ends. */
function runScript(step: Step): Promise<number | null> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        join(process.cwd(), "node_modules/tsx/dist/cli.mjs"),
        `tests/e2e/${step.script}.ts`
      ],
      {
        stdio: step.parallel ? ["ignore", "pipe", "pipe"] : "inherit",
        env: { ...process.env, ...(step.env?.() ?? {}) }
      }
    );
    const held: Buffer[] = [];
    child.stdout?.on("data", (chunk: Buffer) => held.push(chunk));
    child.stderr?.on("data", (chunk: Buffer) => held.push(chunk));
    child.on("error", reject);
    child.on("exit", (code) => {
      if (step.parallel) {
        console.log(`\n=== ${step.script} (ran alongside)\n${Buffer.concat(held).toString("utf8")}`);
      }
      resolve(code);
    });
  });
}

async function runStep(step: Step): Promise<Outcome> {
  const reason = step.skipReason?.() ?? null;
  if (reason) {
    console.log(`\n=== ${step.script}: skipped (${reason})`);
    return { script: step.script, result: "skipped", detail: reason };
  }
  if (!step.parallel) console.log(`\n=== ${step.script}`);
  const started = Date.now();
  const code = await runScript(step);
  const seconds = Math.round((Date.now() - started) / 1000);
  return code === 0
    ? { script: step.script, result: "passed", seconds }
    : { script: step.script, result: "failed", detail: `exit code ${code}`, seconds };
}

async function main(): Promise<void> {
  const suiteName = parseSuiteName();
  const steps = SUITES[suiteName] ?? [];
  const started = Date.now();
  const alongside = Promise.all(steps.filter((step) => step.parallel).map((step) => runStep(step)));
  const outcomes: Outcome[] = [];
  for (const step of steps.filter((step) => !step.parallel)) {
    outcomes.push(await runStep(step));
  }
  outcomes.push(...(await alongside));

  console.log(`\n=== ${suiteName} suite summary (${Math.round((Date.now() - started) / 60_000)} min)`);
  for (const outcome of outcomes) {
    const time = outcome.seconds === undefined ? "" : ` ${Math.floor(outcome.seconds / 60)}m${String(outcome.seconds % 60).padStart(2, "0")}s`;
    console.log(
      `${outcome.result.padEnd(7)} ${outcome.script}${time}${outcome.detail ? ` (${outcome.detail})` : ""}`
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
