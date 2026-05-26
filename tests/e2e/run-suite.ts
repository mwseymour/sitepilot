import { spawn } from "node:child_process";
import { join } from "node:path";

const SUITES: Record<string, string[]> = {
  smoke: [
    "create-simple-draft-post",
    "create-designed-post-mixed-core-blocks"
  ],
  content: [
    "create-simple-draft-post",
    "create-designed-post-mixed-core-blocks",
    "edit-existing-page-structured-update",
    "add-image-to-new-post"
  ],
  all: [
    "create-simple-draft-post",
    "create-designed-post-mixed-core-blocks",
    "edit-existing-page-structured-update",
    "add-image-to-new-post",
    "create-page-from-screenshot-reference"
  ]
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

async function runScenario(scenario: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [join(process.cwd(), "node_modules/tsx/dist/cli.mjs"), "tests/e2e/run.ts", "--scenario", scenario],
      {
        stdio: "inherit",
        env: process.env
      }
    );
    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`Scenario "${scenario}" failed with exit code ${code}.`));
    });
  });
}

async function main(): Promise<void> {
  const suiteName = parseSuiteName();
  const scenarios = SUITES[suiteName];

  console.log(
    `Running SitePilot E2E suite "${suiteName}" with scenarios: ${scenarios.join(", ")}`
  );

  for (const scenario of scenarios) {
    console.log(`\n=== ${scenario} ===`);
    await runScenario(scenario);
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
