import { readdirSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { E2E_ARTIFACTS_ROOT } from "./config.js";

const latest = readdirSync(E2E_ARTIFACTS_ROOT, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort()
  .at(-1);

if (!latest) {
  throw new Error("No E2E reports found.");
}

const reportPath = join(E2E_ARTIFACTS_ROOT, latest, "report.html");
execFileSync("open", [reportPath]);
console.log(reportPath);
