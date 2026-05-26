/* global console, process */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";

if (process.platform !== "darwin") {
  process.exit(0);
}

const require = createRequire(import.meta.url);
const electronPackagePath = require.resolve("electron/package.json", {
  paths: [process.cwd()]
});
const appPath = join(dirname(electronPackagePath), "dist", "Electron.app");
const sqlitePackagePath = require.resolve("better-sqlite3/package.json", {
  paths: [process.cwd()]
});
const sqliteAddonPath = join(
  dirname(sqlitePackagePath),
  "build",
  "Release",
  "better_sqlite3.node"
);

function removeMacOsAttributes(targetPath) {
  for (const attribute of ["com.apple.provenance", "com.apple.quarantine"]) {
    try {
      execFileSync("xattr", ["-dr", attribute, targetPath], { stdio: "ignore" });
    } catch {
      // Ignore missing attributes.
    }
  }
}

if (!existsSync(appPath)) {
  console.error(`Electron app bundle not found at ${appPath}`);
  process.exit(1);
}

if (!existsSync(sqliteAddonPath)) {
  console.error(`better-sqlite3 addon not found at ${sqliteAddonPath}`);
  process.exit(1);
}

removeMacOsAttributes(sqliteAddonPath);
execFileSync("codesign", ["--force", "--sign", "-", sqliteAddonPath], {
  stdio: "inherit"
});

removeMacOsAttributes(appPath);
execFileSync("codesign", ["--force", "--deep", "--sign", "-", appPath], {
  stdio: "inherit"
});
