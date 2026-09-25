import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { gutenbergV2BlockManifest } from "../packages/contracts/src/gutenberg-v2.js";

// The WordPress plugin reads this file for its v2 block policy and passes it to
// the editor bridge. Regenerate it whenever GUTENBERG_V2_SUPPORT_MATRIX changes;
// tests/gutenberg-v2-block-manifest.test.ts fails if it drifts.
const target = join(
  process.cwd(),
  "plugins/wordpress-sitepilot/includes/V2/block-manifest.json"
);
writeFileSync(
  target,
  `${JSON.stringify(gutenbergV2BlockManifest(), null, 2)}\n`,
  "utf8"
);
console.log(`Wrote ${target}`);
