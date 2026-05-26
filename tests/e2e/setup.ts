import { E2E_BASE_URL, E2E_REGISTRATION_CODE } from "./config.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

async function assertReachable(url: string): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(
      `Expected ${url} to be reachable, received HTTP ${response.status}.`
    );
  }
}

async function main(): Promise<void> {
  console.log(`Validating managed WordPress test site at ${E2E_BASE_URL}`);

  if (E2E_BASE_URL !== "https://test.localhost:8890/") {
    throw new Error(
      `Refusing to run setup against ${E2E_BASE_URL}. Expected exactly https://test.localhost:8890/.`
    );
  }

  await assertReachable(E2E_BASE_URL);
  await assertReachable(`${E2E_BASE_URL}wp-json/sitepilot/v1/protocol`);
  await assertReachable(`${E2E_BASE_URL}wp-login.php`);

  console.log("Managed site is reachable.");
  console.log(
    "No reset was performed. This harness now targets the existing managed site."
  );
  console.log(
    `Using registration code from environment/config: ${E2E_REGISTRATION_CODE.length > 0 ? "present" : "missing"}`
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
