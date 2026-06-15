const [major, minor, patch] = process.versions.node.split(".").map(Number);

const minimumMajor = 22;
const minimumMinor = 22;
const minimumPatch = 3;

const isSupported =
  major > minimumMajor ||
  (major === minimumMajor &&
    (minor > minimumMinor ||
      (minor === minimumMinor && patch >= minimumPatch)));

if (!isSupported) {
  console.error(
    [
      `Unsupported Node.js version: ${process.versions.node}.`,
      `SitePilot E2E requires Node ${minimumMajor}.${minimumMinor}.${minimumPatch}+ because native dependencies like better-sqlite3 are built for supported ABIs only.`,
      "Switch to Node 22.22.3+ and run `npm install` (or `npm rebuild better-sqlite3`) before rerunning `npm run test:e2e`."
    ].join("\n")
  );
  process.exit(1);
}
