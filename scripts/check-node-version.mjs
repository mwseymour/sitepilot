const [major, minor] = process.versions.node.split(".").map(Number);

const minimumMajor = 22;
const minimumMinor = 12;

const isSupported =
  major > minimumMajor ||
  (major === minimumMajor && minor >= minimumMinor);

if (!isSupported) {
  console.error(
    [
      `Unsupported Node.js version: ${process.versions.node}.`,
      `SitePilot E2E requires Node ${minimumMajor}.${minimumMinor}+ because native dependencies like better-sqlite3 are built for supported ABIs only.`,
      "Switch to Node 22.12+ and run `npm install` (or `npm rebuild better-sqlite3`) before rerunning `npm run test:e2e`."
    ].join("\n")
  );
  process.exit(1);
}
