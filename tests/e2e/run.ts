import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { chromium, type BrowserContext } from "playwright";

import type { ActionPlan, ImageAttachmentPayload } from "@sitepilot/contracts";
import { initializeDatabase } from "@sitepilot/repositories";

import { getDatabase } from "../../apps/desktop/src/main/app-database.js";
import {
  createChatThreadForSite,
  createTypedRequestForThread
} from "../../apps/desktop/src/main/chat-service.js";
import { refreshDiscoveryForSite } from "../../apps/desktop/src/main/discovery-service.js";
import { executePlanAction } from "../../apps/desktop/src/main/execution-orchestrator-service.js";
import {
  generateActionPlanForRequest,
  generateFixtureBackedActionPlanForRequest
} from "../../apps/desktop/src/main/plan-generation-service.js";
import { registerSiteWithWordPress } from "../../apps/desktop/src/main/register-site.js";
import { configureRuntimeContext } from "../../apps/desktop/src/main/runtime-context.js";
import { saveSitePlannerSettings } from "../../apps/desktop/src/main/settings-service.js";
import { generateAndPersistSiteConfigDraft } from "../../apps/desktop/src/main/site-config-draft.js";
import { confirmSiteConfigActivation } from "../../apps/desktop/src/main/site-workspace-service.js";

import {
  E2E_ADMIN_PASSWORD,
  E2E_ADMIN_USERNAME,
  E2E_ANTHROPIC_API_KEY,
  E2E_ARTIFACTS_ROOT,
  E2E_BASE_URL,
  E2E_OPENAI_API_KEY,
  E2E_REGISTRATION_CODE
} from "./config.js";
import { createFileSecureStorage } from "./file-secure-storage.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

type ScenarioDefinition = {
  slug: string;
  prompt: string;
  fixturePath: string;
  expectedTexts: string[];
  previewMustContain?: string[];
  previewMustNotContain?: string[];
  editorMustContain?: string[];
  attachmentPaths?: string[];
  requireLocalUploadedImage?: boolean;
  requiredImageAltText?: string;
};

type ParsedArgs =
  | { mode: "scenario"; scenario: ScenarioDefinition }
  | {
      mode: "prompt";
      prompt: string;
      runSlugBase: string;
      replayContext?: Record<string, unknown>;
      exportedPlan?: ActionPlan;
    };

type ParsedExportedBundle = {
  bundle: ExportedBundle;
  leadingText?: string;
};

type ExportedBundle = {
  exportedAt?: string;
  site?: {
    id?: string;
    name?: string;
    baseUrl?: string;
    environment?: string;
    activationStatus?: string;
  };
  uiState?: {
    selectedThreadId?: string;
    lastRequestId?: string;
  };
  bundle?: {
    ok?: boolean;
    request?: {
      id?: string;
      threadId?: string;
      status?: string;
      userPrompt?: string;
      latestPlanId?: string;
      latestExecutionRunId?: string;
    };
    plan?: {
      id?: string;
      requestSummary?: string;
      assumptions?: string[];
      targetEntities?: string[];
    };
    execution?: {
      id?: string;
      actionId?: string;
      after?: {
        post_title?: string;
        post_status?: string;
      };
    };
  };
};

const SCENARIOS: Record<string, ScenarioDefinition> = {
  "create-simple-draft-post": {
    slug: "create-simple-draft-post",
    prompt:
      "Create a draft post called Automated Test Post with three short paragraphs about first-time buyer mortgage advice.",
    fixturePath: join(
      process.cwd(),
      "tests/e2e/fixtures/create-simple-draft-post.plan.json"
    ),
    expectedTexts: [
      "Buying your first home is easier when you set a firm budget before you start viewing properties.",
      "Speak to a broker early so you understand how your deposit, income, and credit history affect the mortgage options available.",
      "Keep some savings back for surveys, legal fees, and moving costs so the purchase does not stretch your finances too tightly."
    ]
  },
  "edit-existing-page-structured-update": {
    slug: "edit-existing-page-structured-update",
    prompt:
      "Create a draft page, then update the services section and call to action while keeping the hero structure intact.",
    fixturePath: join(
      process.cwd(),
      "tests/e2e/fixtures/edit-existing-page-structured-update.plan.json"
    ),
    expectedTexts: [
      "Trusted support for growing teams",
      "Operational reviews that remove delivery bottlenecks before they slow down launches.",
      "Book a planning session"
    ],
    previewMustNotContain: [
      "Legacy services copy that should be replaced during the update step."
    ]
  },
  "create-designed-post-mixed-core-blocks": {
    slug: "create-designed-post-mixed-core-blocks",
    prompt:
      "Create a draft post with a heading, intro paragraph, two columns, an image, a quote, and a CTA button.",
    fixturePath: join(
      process.cwd(),
      "tests/e2e/fixtures/create-designed-post-mixed-core-blocks.plan.json"
    ),
    expectedTexts: [
      "Home Buying Roadmap",
      "Know your numbers",
      "A steady plan beats rushed decisions every time.",
      "Talk to an adviser"
    ],
    previewMustContain: [
      "wp-block-image",
      "wp-block-columns",
      "wp-block-quote",
      "wp-block-buttons"
    ]
  },
  "add-image-to-new-post": {
    slug: "add-image-to-new-post",
    prompt:
      "Create a new draft post with the attached image directly under the main heading.",
    fixturePath: join(
      process.cwd(),
      "tests/e2e/fixtures/add-image-to-new-post.plan.json"
    ),
    expectedTexts: [
      "Mortgage Checklist",
      "Start with a realistic monthly budget before comparing properties.",
      "Keep part of your savings available for surveys, legal fees, and moving costs."
    ],
    previewMustContain: ["wp-block-image"],
    attachmentPaths: [join(process.cwd(), "tests/e2e/fixtures/test.jpeg")],
    requireLocalUploadedImage: true,
    requiredImageAltText: "Open notebook and mortgage planning notes on a desk"
  },
  "create-page-from-screenshot-reference": {
    slug: "create-page-from-screenshot-reference",
    prompt:
      "Create a draft page using the attached screenshot as a layout reference. Match the section order with a hero, metrics row, feature cards, and a final CTA.",
    fixturePath: join(
      process.cwd(),
      "tests/e2e/fixtures/create-page-from-screenshot-reference.plan.json"
    ),
    expectedTexts: [
      "Launch planning for busy product teams",
      "Delivery health in one weekly review",
      "See the planning system"
    ],
    previewMustContain: ["wp-block-group", "wp-block-columns", "wp-block-buttons"],
    attachmentPaths: [
      join(
        process.cwd(),
        "tests/e2e/fixtures/layout-reference-screenshot.jpg"
      )
    ]
  }
};

function mediaTypeFromPath(filePath: string): string {
  const extension = extname(filePath).toLowerCase();
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".svg") {
    return "image/svg+xml";
  }
  throw new Error(`Unsupported fixture attachment type for ${filePath}.`);
}

function loadScenarioAttachments(paths: string[] | undefined): ImageAttachmentPayload[] | undefined {
  if (!paths || paths.length === 0) {
    return undefined;
  }

  return paths.map((filePath) => {
    const bytes = readFileSync(filePath);
    const mediaType = mediaTypeFromPath(filePath);
    return {
      fileName: basename(filePath),
      mediaType,
      sizeBytes: bytes.length,
      dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`
    };
  });
}

function getArgValue(flag: string): string | undefined {
  const index = process.argv.findIndex((arg) => arg === flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function parseArgs(): ParsedArgs {
  const prompt = getArgValue("--prompt");
  const requestFile = getArgValue("--request-file");

  if (prompt && requestFile) {
    throw new Error("Use either --prompt or --request-file, not both.");
  }

  if (prompt) {
    return {
      mode: "prompt",
      prompt,
      runSlugBase: `replay-${slugify(prompt)}`
    };
  }

  if (requestFile) {
    const fileContents = readFileSync(requestFile, "utf8").trim();
    if (fileContents.length === 0) {
      throw new Error(`Request file ${requestFile} is empty.`);
    }

    const parsedExport = parseExportedBundle(fileContents);
    if (parsedExport) {
      const replayPrompt = parsedExport.bundle.bundle?.request?.userPrompt?.trim();
      if (!replayPrompt) {
        throw new Error(
          `Request file ${requestFile} looks like a SitePilot export, but bundle.request.userPrompt is missing.`
        );
      }
      const replayContext = buildReplayContext(
        parsedExport.bundle,
        parsedExport.leadingText
      );
      const exportedPlan = normalizeExportedPlan(parsedExport.bundle);
      return {
        mode: "prompt",
        prompt: replayPrompt,
        runSlugBase: `replay-${slugify(replayPrompt)}`,
        ...(exportedPlan ? { exportedPlan } : {}),
        ...(replayContext ? { replayContext } : {})
      };
    }

    return {
      mode: "prompt",
      prompt: fileContents,
      runSlugBase: `replay-${slugify(fileContents)}`
    };
  }

  const scenarioSlug = getArgValue("--scenario") ?? "create-simple-draft-post";
  const scenario = SCENARIOS[scenarioSlug];
  if (!scenario) {
    throw new Error(`Unknown scenario: ${scenarioSlug}`);
  }
  return { mode: "scenario", scenario };
}

function parseExportedBundle(fileContents: string): ParsedExportedBundle | null {
  const trimmed = fileContents.trim();

  const parseCandidate = (
    candidate: string,
    leadingText?: string
  ): ParsedExportedBundle | null => {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      if (
        parsed &&
        typeof parsed === "object" &&
        !Array.isArray(parsed) &&
        "bundle" in parsed
      ) {
        return {
          bundle: parsed as ExportedBundle,
          ...(leadingText && leadingText.trim().length > 0
            ? { leadingText: leadingText.trim() }
            : {})
        };
      }
      return null;
    } catch {
      return null;
    }
  };

  const direct = parseCandidate(trimmed);
  if (direct) {
    return direct;
  }

  const jsonStart = trimmed.indexOf("{");
  if (jsonStart <= 0) {
    return null;
  }

  return parseCandidate(trimmed.slice(jsonStart), trimmed.slice(0, jsonStart));
}

function buildReplayContext(
  exportedBundle: ExportedBundle,
  leadingText?: string
): Record<string, unknown> | undefined {
  const request = exportedBundle.bundle?.request;
  const plan = exportedBundle.bundle?.plan;
  const execution = exportedBundle.bundle?.execution;

  const context: Record<string, unknown> = {
    replayInstructionPrefix:
      leadingText && leadingText.trim().length > 0 ? leadingText.trim() : undefined,
    exportedAt: exportedBundle.exportedAt,
    sourceSite: exportedBundle.site
      ? {
          id: exportedBundle.site.id,
          name: exportedBundle.site.name,
          baseUrl: exportedBundle.site.baseUrl,
          environment: exportedBundle.site.environment,
          activationStatus: exportedBundle.site.activationStatus
        }
      : undefined,
    sourceRequest: request
      ? {
          id: request.id,
          threadId: request.threadId,
          status: request.status,
          latestPlanId: request.latestPlanId,
          latestExecutionRunId: request.latestExecutionRunId
        }
      : undefined,
    sourcePlan: plan
      ? {
          id: plan.id,
          requestSummary: plan.requestSummary,
          assumptions: plan.assumptions,
          targetEntities: plan.targetEntities
        }
      : undefined,
    sourceExecution: execution
      ? {
          id: execution.id,
          actionId: execution.actionId,
          after: execution.after
        }
      : undefined,
    sourceUiState: exportedBundle.uiState
      ? {
          selectedThreadId: exportedBundle.uiState.selectedThreadId,
          lastRequestId: exportedBundle.uiState.lastRequestId
        }
      : undefined
  };

  const compact = Object.fromEntries(
    Object.entries(context).filter(([, value]) => value !== undefined)
  );

  return Object.keys(compact).length > 0 ? compact : undefined;
}

function normalizeExportedPlan(
  exportedBundle: ExportedBundle
): ActionPlan | undefined {
  const rawPlan = exportedBundle.bundle?.plan;
  if (!rawPlan || typeof rawPlan !== "object") {
    return undefined;
  }
  return rawPlan as ActionPlan;
}

function remapExportedPlan(input: {
  plan: ActionPlan;
  requestId: string;
  siteId: string;
  nowIso: string;
}): ActionPlan {
  return {
    ...input.plan,
    id: `${input.plan.id}-replay`,
    requestId: input.requestId,
    siteId: input.siteId,
    proposedActions: input.plan.proposedActions.map((action, index) => ({
      ...action,
      id: `${action.id}-replay-${index + 1}`
    })),
    createdAt: input.nowIso,
    updatedAt: input.nowIso
  };
}

function assertSafeBaseUrl(url: string): void {
  if (url !== "https://test.localhost:8890/") {
    throw new Error(
      `Refusing to run E2E against ${url}. Expected exactly https://test.localhost:8890/.`
    );
  }
}

function testTitlePrefix(now: Date): string {
  const hhmm = now
    .toLocaleTimeString("en-GB", {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false
    })
    .replace(":", "");
  const ddmmyyyy = now
    .toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    })
    .replace(/\//g, "");
  return `AUTOMATED-TEST-${hhmm}-${ddmmyyyy}`;
}

function toTitleWords(value: string): string {
  return value
    .replace(/^replay-/, "")
    .split(/[^a-z0-9]+/i)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function buildTestTitle(input: { now: Date; runSlugBase: string }): string {
  const prefix = testTitlePrefix(input.now);
  const suffix = toTitleWords(input.runSlugBase);
  return suffix.length > 0 ? `${prefix}-${suffix}` : prefix;
}

function buildFixturePlan(input: {
  fixturePath: string;
  requestId: string;
  siteId: string;
  title: string;
  nowIso: string;
}): ActionPlan {
  const raw = readFileSync(input.fixturePath, "utf8")
    .replaceAll("__REQUEST_ID__", input.requestId)
    .replaceAll("__SITE_ID__", input.siteId)
    .replaceAll("__TITLE__", input.title)
    .replaceAll("__NOW__", input.nowIso);
  return JSON.parse(raw) as ActionPlan;
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, JSON.stringify(value, null, 2), "utf8");
}

function writeHtmlReport(
  filePath: string,
  summary: Record<string, unknown>
): void {
  writeFileSync(
    filePath,
    `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <title>SitePilot E2E Report</title>
  <style>
    body { font-family: ui-sans-serif, system-ui, sans-serif; margin: 32px; line-height: 1.5; }
    pre { white-space: pre-wrap; word-break: break-word; background: #f5f5f5; padding: 16px; border-radius: 8px; }
  </style>
</head>
<body>
  <h1>SitePilot E2E Report</h1>
  <pre>${escapeHtml(JSON.stringify(summary, null, 2))}</pre>
</body>
</html>`,
    "utf8"
  );
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function loginToWordPress(baseUrl: string): Promise<BrowserContext> {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await context.newPage();
  await page.goto(`${baseUrl}wp-login.php`, { waitUntil: "networkidle" });
  await page.locator("#user_login").fill(E2E_ADMIN_USERNAME);
  await page.locator("#user_pass").fill(E2E_ADMIN_PASSWORD);
  await page.locator("#wp-submit").click();
  try {
    await page.waitForURL(/wp-admin/, { timeout: 30000 });
  } catch {
    const loginError = await page
      .locator("#login_error, .message")
      .allTextContents();
    await browser.close();
    throw new Error(
      [
        "Failed to log into wp-admin with the configured E2E credentials.",
        `Tried username: ${E2E_ADMIN_USERNAME}`,
        loginError.length > 0
          ? `WordPress said: ${loginError.join(" ").trim()}`
          : null,
        "Set SITEPILOT_E2E_ADMIN_USERNAME and SITEPILOT_E2E_ADMIN_PASSWORD, or create .sitepilot-e2e.local.json with adminUsername/adminPassword."
      ]
        .filter((line): line is string => Boolean(line))
        .join("\n")
    );
  }
  await page.close();
  return context;
}

async function discoverRegistrationCode(): Promise<string> {
  const context = await loginToWordPress(E2E_BASE_URL);
  try {
    const page = await context.newPage();
    await page.goto(
      `${E2E_BASE_URL}wp-admin/options-general.php?page=sitepilot`,
      {
        waitUntil: "networkidle"
      }
    );
    const codeText = await page.locator("code").allTextContents();
    await page.close();
    const discovered = codeText
      .map((value) => value.trim())
      .find((value) => /^[A-Za-z0-9]{16,}$/.test(value));
    if (!discovered) {
      throw new Error(
        "Could not discover the SitePilot registration code from wp-admin."
      );
    }
    return discovered;
  } finally {
    await context.browser()?.close();
  }
}

async function fetchPostViaRest(
  context: BrowserContext,
  postId: number
): Promise<Record<string, unknown> | null> {
  const page = await context.newPage();
  try {
    return (await page.evaluate(async (resolvedPostId) => {
      const response = await fetch(
        `https://test.localhost:8890/wp-json/wp/v2/posts/${resolvedPostId}?context=edit`,
        {
          credentials: "include"
        }
      );
      if (!response.ok) {
        return null;
      }
      return (await response.json()) as Record<string, unknown>;
    }, postId)) as Record<string, unknown> | null;
  } finally {
    await page.close();
  }
}

function stringValue(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function nestedRenderedText(
  record: Record<string, unknown>,
  key: string
): string | undefined {
  const value = record[key];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  const rendered = (value as Record<string, unknown>).rendered;
  return typeof rendered === "string" ? rendered : undefined;
}

async function verifyResult(input: {
  artifactDir: string;
  expectedTexts: string[];
  postId: number;
  postType: string;
  titlePrefix?: string;
  previewMustContain?: string[];
  previewMustNotContain?: string[];
  editorMustContain?: string[];
  requireLocalUploadedImage?: boolean;
  requiredImageAltText?: string;
}): Promise<Record<string, unknown>> {
  const previewUrl =
    input.postType === "page"
      ? `${E2E_BASE_URL}?page_id=${input.postId}&preview=true`
      : `${E2E_BASE_URL}?p=${input.postId}&preview=true`;
  const editorUrl = `${E2E_BASE_URL}wp-admin/post.php?post=${input.postId}&action=edit`;
  const context = await loginToWordPress(E2E_BASE_URL);

  try {
    const previewPage = await context.newPage();
    await previewPage.goto(previewUrl, { waitUntil: "domcontentloaded" });
    await previewPage.locator("body").waitFor();
    for (const expectedText of input.expectedTexts) {
      await previewPage.locator(`text=${expectedText}`).waitFor();
    }
    await previewPage.screenshot({
      path: join(input.artifactDir, "preview.png"),
      fullPage: true
    });
    writeFileSync(
      join(input.artifactDir, "preview.html"),
      await previewPage.content(),
      "utf8"
    );
    const previewText = (await previewPage.locator("body").textContent()) ?? "";
    const previewHtml = await previewPage.content();
    for (const snippet of input.previewMustContain ?? []) {
      if (!previewHtml.includes(snippet) && !previewText.includes(snippet)) {
        throw new Error(`Preview did not contain expected snippet: ${snippet}`);
      }
    }
    for (const snippet of input.previewMustNotContain ?? []) {
      if (previewHtml.includes(snippet) || previewText.includes(snippet)) {
        throw new Error(`Preview still contained forbidden snippet: ${snippet}`);
      }
    }
    let uploadedImageCount = 0;
    if (input.requireLocalUploadedImage) {
      const imageLocator = input.requiredImageAltText
        ? previewPage.locator(
            `img[alt="${input.requiredImageAltText}"][src*="/wp-content/uploads/"]`
          )
        : previewPage.locator(`img[src*="/wp-content/uploads/"]`);
      uploadedImageCount = await imageLocator.count();
      if (uploadedImageCount === 0) {
        throw new Error(
          "Preview did not contain a locally uploaded image in /wp-content/uploads/."
        );
      }
      const firstImageLoaded = await imageLocator.first().evaluate((image) => {
        const element = image as HTMLImageElement;
        return element.complete && element.naturalWidth > 0;
      });
      if (!firstImageLoaded) {
        throw new Error("Preview image did not finish loading successfully.");
      }
    }
    await previewPage.close();

    const editorPage = await context.newPage();
    await editorPage.goto(editorUrl, { waitUntil: "domcontentloaded" });
    await editorPage
      .locator("body.wp-admin, .edit-post-layout, .interface-interface-skeleton")
      .first()
      .waitFor();
    const editorText = (await editorPage.locator("body").textContent()) ?? "";
    if (editorText.includes("unexpected or invalid content")) {
      throw new Error("Gutenberg reported invalid block content.");
    }
    await editorPage.screenshot({
      path: join(input.artifactDir, "editor.png"),
      fullPage: true
    });
    writeFileSync(
      join(input.artifactDir, "editor.html"),
      await editorPage.content(),
      "utf8"
    );
    for (const snippet of input.editorMustContain ?? []) {
      if (!editorText.includes(snippet)) {
        throw new Error(`Editor did not contain expected snippet: ${snippet}`);
      }
    }
    await editorPage.close();

    const postRecord = await fetchPostViaRest(context, input.postId);
    if (postRecord) {
      writeJson(join(input.artifactDir, "post.json"), postRecord);

      const title =
        nestedRenderedText(postRecord, "title") ??
        stringValue(postRecord, "title");
      const content =
        nestedRenderedText(postRecord, "content") ??
        stringValue(postRecord, "content");
      const status = stringValue(postRecord, "status");

      if (!title || title.trim().length === 0) {
        throw new Error("Verified post has an empty title.");
      }
      if (input.titlePrefix && !title.startsWith(input.titlePrefix)) {
        throw new Error(
          `Expected post title to start with "${input.titlePrefix}", received "${title}".`
        );
      }
      if (status !== "draft") {
        throw new Error(
          `Expected draft status, received "${status ?? "unknown"}".`
        );
      }
      if (!content || !content.includes("<!-- wp:")) {
        throw new Error(
          "Persisted post content does not contain Gutenberg block markup."
        );
      }
      if (content.includes("wp:classic")) {
        throw new Error("Persisted post content fell back to a Classic block.");
      }

      return {
        title,
        status,
        contentLength: content.length,
        verificationMode: "rest+browser",
        ...(input.requireLocalUploadedImage ? { uploadedImageCount } : {})
      };
    }

    if (input.titlePrefix && !previewText.includes(input.titlePrefix)) {
      throw new Error(
        `Expected preview content to include title prefix "${input.titlePrefix}".`
      );
    }

    return {
      title: null,
      status: "draft",
      contentLength: previewText.length,
      verificationMode: "browser-only"
    };
  } finally {
    await context.browser()?.close();
  }
}

function findCreatedPostId(
  executionResults: Array<{ mcpResult: Record<string, unknown> }>
): { postId: number; postType: string } {
  for (const result of executionResults) {
    const postId = result.mcpResult.post_id;
    if (typeof postId === "number" && Number.isFinite(postId) && postId > 0) {
      return {
        postId,
        postType:
          typeof result.mcpResult.post_type === "string"
            ? result.mcpResult.post_type
            : "post"
      };
    }
  }
  throw new Error("Execution did not return a post_id.");
}

async function seedProviderSecrets(storageRoot: string): Promise<void> {
  const storage = createFileSecureStorage(storageRoot);
  if (E2E_OPENAI_API_KEY) {
    await storage.set(
      { namespace: "provider", keyId: "openai" },
      E2E_OPENAI_API_KEY
    );
  }
  if (E2E_ANTHROPIC_API_KEY) {
    await storage.set(
      { namespace: "provider", keyId: "anthropic" },
      E2E_ANTHROPIC_API_KEY
    );
  }
}

async function registerManagedSite(input: {
  baseUrl: string;
  siteName: string;
  wordpressUsername: string;
}): Promise<Awaited<ReturnType<typeof registerSiteWithWordPress>> | never> {
  const tryRegister = async (registrationCode: string) =>
    registerSiteWithWordPress({
      baseUrl: input.baseUrl,
      registrationCode,
      siteName: input.siteName,
      wordpressUsername: input.wordpressUsername,
      environment: "development"
    });

  const configuredAttempt = await tryRegister(E2E_REGISTRATION_CODE);
  if (configuredAttempt.ok) {
    return configuredAttempt;
  }
  if (configuredAttempt.code !== "register_rejected") {
    return configuredAttempt;
  }
  if (!/invalid registration code/i.test(configuredAttempt.message)) {
    return configuredAttempt;
  }

  const discoveredCode = await discoverRegistrationCode();
  const discoveredAttempt = await tryRegister(discoveredCode);
  if (discoveredAttempt.ok) {
    return discoveredAttempt;
  }
  return discoveredAttempt;
}

async function main(): Promise<void> {
  const args = parseArgs();
  assertSafeBaseUrl(E2E_BASE_URL);

  const now = new Date();
  const runSlugBase =
    args.mode === "scenario" ? args.scenario.slug : args.runSlugBase;
  const runSlug = `${runSlugBase}-${now.toISOString().replaceAll(":", "-")}`;
  const artifactDir = join(E2E_ARTIFACTS_ROOT, runSlug);
  mkdirSync(artifactDir, { recursive: true });

  const runtimeDir = join(tmpdir(), `sitepilot-e2e-${runSlug}`);
  rmSync(runtimeDir, { recursive: true, force: true });
  mkdirSync(runtimeDir, { recursive: true });

  const secureStorageRoot = join(runtimeDir, "secure-store");
  await seedProviderSecrets(secureStorageRoot);

  const database = initializeDatabase({
    filePath: join(runtimeDir, "sitepilot.sqlite")
  });
  configureRuntimeContext({
    userDataPath: runtimeDir,
    database,
    secureStorage: createFileSecureStorage(secureStorageRoot)
  });

  const db = getDatabase();
  const titlePrefix = testTitlePrefix(now);
  const testTitle = buildTestTitle({ now, runSlugBase });
  const scenarioAttachments =
    args.mode === "scenario"
      ? loadScenarioAttachments(args.scenario.attachmentPaths)
      : undefined;
  const requestPrompt =
    args.mode === "scenario"
      ? args.scenario.prompt
      : `${args.prompt}\n\nTest constraint: If you create a new post or page, title it ${testTitle} and keep it as a draft unless the original request explicitly asked otherwise.${
          args.replayContext
            ? `\n\nReplay context from the original SitePilot export:\n${JSON.stringify(args.replayContext, null, 2)}`
            : ""
        }`;

  console.log(`Running SitePilot E2E against ${E2E_BASE_URL}`);

  const registration = await registerManagedSite({
    baseUrl: E2E_BASE_URL,
    siteName: "SitePilot E2E",
    wordpressUsername: E2E_ADMIN_USERNAME
  });
  if (!registration.ok) {
    throw new Error(registration.message);
  }
  const siteId = registration.site.id;

  await saveSitePlannerSettings(
    createFileSecureStorage(secureStorageRoot),
    siteId,
    {
      bypassApprovalRequests: true
    }
  );

  const discovery = await refreshDiscoveryForSite(siteId);
  if (!discovery.ok) {
    throw new Error(discovery.message);
  }

  const draftConfig = await generateAndPersistSiteConfigDraft(siteId);
  if (!draftConfig.ok) {
    throw new Error(draftConfig.message);
  }
  const activation = await confirmSiteConfigActivation(
    siteId,
    draftConfig.siteConfig.id
  );
  if (!activation.ok) {
    throw new Error(activation.message);
  }

  const thread = await createChatThreadForSite(siteId, {
    title: "Automated E2E",
    type: "general_request"
  });
  if (!thread.ok) {
    throw new Error(thread.message);
  }

  const request = await createTypedRequestForThread(
    siteId,
    thread.thread.id,
    requestPrompt,
    scenarioAttachments
  );
  if (!request.ok) {
    throw new Error(request.message);
  }

  let planResult:
    | Awaited<ReturnType<typeof generateFixtureBackedActionPlanForRequest>>
    | Awaited<ReturnType<typeof generateActionPlanForRequest>>;

  if (args.mode === "scenario") {
    const fixturePlan = buildFixturePlan({
      fixturePath: args.scenario.fixturePath,
      requestId: request.request.id,
      siteId,
      title: testTitle,
      nowIso: now.toISOString()
    });
    writeJson(join(artifactDir, "fixture-plan.json"), fixturePlan);
    planResult = await generateFixtureBackedActionPlanForRequest({
      siteId,
      threadId: thread.thread.id,
      requestId: request.request.id,
      plan: fixturePlan
    });
  } else {
    if (args.exportedPlan) {
      const replayPlan = remapExportedPlan({
        plan: args.exportedPlan,
        requestId: request.request.id,
        siteId,
        nowIso: now.toISOString()
      });
      writeJson(join(artifactDir, "fixture-plan.json"), replayPlan);
      planResult = await generateFixtureBackedActionPlanForRequest({
        siteId,
        threadId: thread.thread.id,
        requestId: request.request.id,
        plan: replayPlan,
        preservePlanExactly: true
      });
    } else {
      if (!E2E_OPENAI_API_KEY && !E2E_ANTHROPIC_API_KEY) {
        throw new Error(
          "Prompt replay requires OPENAI_API_KEY or ANTHROPIC_API_KEY in the environment."
        );
      }
      planResult = await generateActionPlanForRequest(
        siteId,
        thread.thread.id,
        request.request.id
      );
    }
  }

  if (!planResult.ok) {
    throw new Error(planResult.message);
  }
  writeJson(join(artifactDir, "final-plan.json"), planResult.plan);

  const executionResults = [];
  for (const action of planResult.plan.proposedActions) {
    const result = await executePlanAction({
      siteId,
      requestId: request.request.id,
      planId: planResult.plan.id,
      actionId: action.id,
      dryRun: false
    });
    if (!result.ok) {
      throw new Error(result.message);
    }
    executionResults.push(result);
  }
  writeJson(join(artifactDir, "execution-results.json"), executionResults);

  const createdEntity = findCreatedPostId(executionResults);
  const verification = await verifyResult({
    artifactDir,
    expectedTexts: args.mode === "scenario" ? args.scenario.expectedTexts : [],
    postId: createdEntity.postId,
    postType: createdEntity.postType,
    ...(args.mode === "scenario" ? { titlePrefix } : {}),
    ...(args.mode === "scenario"
      ? {
          previewMustContain: args.scenario.previewMustContain,
          previewMustNotContain: args.scenario.previewMustNotContain,
          editorMustContain: args.scenario.editorMustContain,
          requireLocalUploadedImage: args.scenario.requireLocalUploadedImage,
          requiredImageAltText: args.scenario.requiredImageAltText
        }
      : {})
  });

  const auditEntries = await db.repositories.auditEntries.listByRequestId(
    request.request.id
  );
  const toolInvocations = (
    await Promise.all(
      executionResults
        .filter((result) => result.executionRunId !== undefined)
        .map((result) =>
          db.repositories.toolInvocations.listByExecutionRunId(
            result.executionRunId!
          )
        )
    )
  ).flat();

  const summary = {
    mode: args.mode === "scenario" ? "fixture-backed" : "prompt-replay",
    scenario: args.mode === "scenario" ? args.scenario.slug : null,
    usedRealApprovalPath: false,
    prompt: args.mode === "scenario" ? requestPrompt : args.prompt,
    executedPrompt: requestPrompt,
    replayContext: args.mode === "prompt" ? (args.replayContext ?? null) : null,
    siteId,
    threadId: thread.thread.id,
    requestId: request.request.id,
    planId: planResult.plan.id,
    postId: createdEntity.postId,
    postType: createdEntity.postType,
    postPreviewUrl:
      createdEntity.postType === "page"
        ? `${E2E_BASE_URL}?page_id=${createdEntity.postId}&preview=true`
        : `${E2E_BASE_URL}?p=${createdEntity.postId}&preview=true`,
    verification,
    auditEventTypes: auditEntries.map((entry) => entry.eventType),
    executionRunIds: executionResults.map((result) => result.executionRunId),
    toolInvocations: toolInvocations.map((invocation) => ({
      id: invocation.id,
      toolName: invocation.toolName,
      input: invocation.input,
      output: invocation.output
    })),
    artifacts: {
      ...(args.mode === "scenario"
        ? { fixturePlan: join(artifactDir, "fixture-plan.json") }
        : {}),
      finalPlan: join(artifactDir, "final-plan.json"),
      executionResults: join(artifactDir, "execution-results.json"),
      previewScreenshot: join(artifactDir, "preview.png"),
      editorScreenshot: join(artifactDir, "editor.png"),
      previewHtml: join(artifactDir, "preview.html"),
      editorHtml: join(artifactDir, "editor.html"),
      postJson: join(artifactDir, "post.json")
    }
  };

  writeJson(join(artifactDir, "summary.json"), summary);
  writeHtmlReport(join(artifactDir, "report.html"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
