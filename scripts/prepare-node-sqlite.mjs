/* global console, process */

import { execFileSync } from "node:child_process";

function canLoadBetterSqlite() {
  try {
    execFileSync(
      process.execPath,
      [
        "-e",
        "const Database = require('better-sqlite3'); const db = new Database(':memory:'); db.prepare('select 1').get(); db.close(); console.log('ok')"
      ],
      {
        stdio: "ignore"
      }
    );
    return true;
  } catch {
    return false;
  }
}

if (canLoadBetterSqlite()) {
  process.exit(0);
}

console.log("Rebuilding better-sqlite3 for the current Node.js runtime...");
execFileSync("npm", ["rebuild", "better-sqlite3"], {
  stdio: "inherit"
});
