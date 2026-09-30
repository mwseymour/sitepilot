// Long, many-block create request planned by a real model, with two attached
// images, run through the desktop v2 boundary: plan, compile, approve, write
// and verify. Needs an OpenAI key in .sitepilot-e2e.local.json.
//
//   SITEPILOT_LONG_POST_IMAGES=/path/a.jpg,/path/b.jpg
//   SITEPILOT_LONG_POST_MODEL=gpt-5.4-mini (default)
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";

import { gutenbergV2RequestStateSchema } from "@sitepilot/contracts";
import type { ImageAttachmentPayload } from "@sitepilot/contracts";
import type { RequestId, SiteId } from "@sitepilot/domain";
import { createOpenAiChatClient } from "@sitepilot/provider-adapters";
import { initializeDatabase } from "@sitepilot/repositories";

import {
  createChatThreadForSite,
  createTypedRequestForThread
} from "../../apps/desktop/src/main/chat-service.js";
import {
  configureGutenbergV2PlannerFactory,
  decideGutenbergV2Candidate,
  executeGutenbergV2Candidate,
  generateGutenbergV2Candidate,
  getGutenbergV2ReviewArtifact
} from "../../apps/desktop/src/main/gutenberg-v2-chat-service.js";
import { getDatabase } from "../../apps/desktop/src/main/app-database.js";
import { registerSiteWithWordPress } from "../../apps/desktop/src/main/register-site.js";
import {
  configureRuntimeContext,
  resetRuntimeContext
} from "../../apps/desktop/src/main/runtime-context.js";

import {
  E2E_ADMIN_USERNAME,
  E2E_ARTIFACTS_ROOT,
  E2E_BASE_URL,
  E2E_OPENAI_API_KEY,
  E2E_REGISTRATION_CODE
} from "./config.js";
import { createFileSecureStorage } from "./file-secure-storage.js";

process.env.NODE_TLS_REJECT_UNAUTHORIZED = "0";

const EXACT_TEST_URL = "https://test.localhost:8890/";

export const LONG_POST_REQUEST = `Title: A Weekend in the Lake District: A Practical Guide for First-Timers

Excerpt: Two days, three walks, and the cafés worth stopping at. A realistic weekend plan for people visiting the Lakes for the first time.

Content:

Cover banner, full width. Use a dark green background (#1F3B2D) at 80% opacity. Put a centred H1 on top saying "A Weekend in the Lake District", with a short paragraph under it: "Fells, lakes and a lot of tea. Here's how to fit the best of it into 48 hours." Add a single button, "Jump to the itinerary", linking to #itinerary.

Intro. Two paragraphs. The first says the Lakes can feel overwhelming because there's too much choice. The second says this guide is based on Keswick, which cuts down on driving. Put Keswick in bold.

Three columns with the heading "At a glance" (H2) above them. Each column has an H3 and a short paragraph:
"Best for": walkers, photographers, pub lovers
"When to go": May–June or September, when it's quieter and drier
"Budget": about £250–£400 per person for the weekend

Separator, then an H2 "The itinerary" with the anchor itinerary.

Day one (H3 "Saturday: Catbells and Derwentwater"). A paragraph, then an ordered list of four steps: park at Hawes End, walk up Catbells (about 2 hours return), take the launch back across Derwentwater, and have dinner in Keswick.

Media & text block. Image on the left (use the attached image, or pick any existing landscape image in the media library). On the right, an H4 "Why Catbells?" and a paragraph saying it has the best views for the least effort in the Lakes.

Pullquote: "If you only climb one fell, make it this one." Citation: "Every Keswick B&B owner, ever".

Day two (H3 "Sunday: Buttermere and Honister Pass"). A paragraph, then a bulleted list: the lakeside loop (4.5 miles, flat), the tearoom stop, and driving back over Honister Pass for the views.

Gallery, three columns, cropped. Use three existing landscape images from the media library.

H2 "What it costs", then a table with a header row and a styled look (stripes if the theme supports it):
| Item | Budget | Comfortable |
|---|---|---|
| Accommodation (2 nights) | £120 | £280 |
| Food & drink | £60 | £110 |
| Parking & launch | £20 | £20 |
| Total | £200 | £410 |

YouTube embed of a Catbells walk video, with the caption "What the ridge actually looks like". (Swap in any public YouTube URL.)

H2 "Frequently asked questions", then an accordion with four items:
"Do I need a car?" Not strictly. Buses run from Penrith to Keswick, and the launch covers Derwentwater.
"Is Catbells suitable for children?" Yes, for most children over 6. There's a short scramble near the top.
"What should I pack?" Waterproofs whatever the forecast, proper footwear, and a paper map.
"Where's the best pub?" The Dog & Gun in Keswick, for the goulash.

Details block with the summary "Safety note: check the fell forecast". Inside, a paragraph pointing to the Mountain Weather Information Service and saying conditions on the tops change fast.

Group block with a light grey background and padding. Inside it: an H3 "Planning your own trip?", a paragraph, and two buttons side by side: "Download the checklist" (filled) and "Read our Scotland guide" (outline).

Featured image: the same image as the media & text block.

SEO (Yoast):
SEO title: Lake District Weekend Guide for First-Timers %%sep%% %%sitename%%
Meta description: A realistic two-day Lake District itinerary from Keswick: Catbells, Buttermere, costs and FAQs for first-time visitors.
Focus keyphrase: lake district weekend
Social title: The only Lake District weekend plan you need
Social description: Two days, three walks, and where to get the best tea.`;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function attachment(path: string): ImageAttachmentPayload {
  const bytes = readFileSync(path);
  const extension = extname(path).slice(1).toLowerCase();
  const mediaType = `image/${extension === "jpg" ? "jpeg" : extension}`;
  return {
    fileName: basename(path),
    mediaType,
    sizeBytes: bytes.length,
    dataUrl: `data:${mediaType};base64,${bytes.toString("base64")}`,
    purpose: "media"
  };
}

async function main(): Promise<void> {
  assert(
    E2E_BASE_URL === EXACT_TEST_URL,
    `Refusing long-post E2E against ${E2E_BASE_URL}. Expected exactly ${EXACT_TEST_URL}`
  );
  assert(E2E_OPENAI_API_KEY, "The long-post E2E needs an OpenAI key.");
  const imagePaths = (process.env.SITEPILOT_LONG_POST_IMAGES ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  const model = process.env.SITEPILOT_LONG_POST_MODEL ?? "gpt-5.4-mini";
  const prompt = process.env.SITEPILOT_LONG_POST_PROMPT_FILE
    ? readFileSync(process.env.SITEPILOT_LONG_POST_PROMPT_FILE, "utf8")
    : LONG_POST_REQUEST;
  const artifactDirectory = join(
    E2E_ARTIFACTS_ROOT,
    `v2-long-post-${new Date().toISOString().replace(/[:.]/g, "-")}`
  );
  mkdirSync(artifactDirectory, { recursive: true });

  const runtimeDir = mkdtempSync(join(tmpdir(), "sitepilot-v2-long-post-"));
  const secureStorage = createFileSecureStorage(join(runtimeDir, "secure-store"));
  const database = initializeDatabase({
    filePath: join(runtimeDir, "sitepilot.sqlite")
  });
  configureRuntimeContext({ userDataPath: runtimeDir, database, secureStorage });
  const report: Record<string, unknown> = { model, images: imagePaths };
  try {
    getDatabase();
    const registration = await registerSiteWithWordPress({
      baseUrl: E2E_BASE_URL,
      siteName: "SitePilot v2 Long Post E2E",
      wordpressUsername: E2E_ADMIN_USERNAME,
      workspaceId: "workspace-1",
      environment: "development",
      registrationCode: E2E_REGISTRATION_CODE
    });
    if (!("site" in registration)) {
      throw new Error(
        `Registration failed (${"code" in registration ? `${registration.code}: ${registration.message}` : "missing site"}).`
      );
    }
    const siteId = registration.site.id as SiteId;
    const site = await database.repositories.sites.getById(siteId);
    assert(site, "Registration did not persist the site.");
    await database.repositories.sites.save({
      ...site,
      activationStatus: "active",
      updatedAt: new Date().toISOString()
    });
    // Replays a saved planner response instead of calling the model.
    const replay = process.env.SITEPILOT_LONG_POST_PLAN_FILE
      ? readFileSync(process.env.SITEPILOT_LONG_POST_PLAN_FILE, "utf8")
      : undefined;
    if (replay) report.replayedPlan = process.env.SITEPILOT_LONG_POST_PLAN_FILE;
    const model_ = createOpenAiChatClient(E2E_OPENAI_API_KEY);
    const openAi: typeof model_ = replay
      ? {
          ...model_,
          complete: async () => ({
            text: replay,
            usage: { inputTokens: 0, outputTokens: 0 }
          })
        }
      : model_;
    let plannerCall = 0;
    const client: typeof openAi = {
      ...openAi,
      complete: async (...args: Parameters<typeof openAi.complete>) => {
        const response = await openAi.complete(...args);
        plannerCall += 1;
        writeFileSync(
          join(artifactDirectory, `planner-response-${plannerCall}.json`),
          response.text
        );
        return response;
      }
    };
    configureGutenbergV2PlannerFactory(async () => ({
      ok: true as const,
      client,
      model
    }));

    const thread = await createChatThreadForSite(siteId, {
      title: "Long post E2E",
      type: "general_request"
    });
    if (!("thread" in thread)) throw new Error("Thread creation failed.");
    const request = await createTypedRequestForThread(
      siteId,
      thread.thread.id,
      prompt,
      imagePaths.map(attachment)
    );
    if (!("request" in request)) throw new Error("Request creation failed.");
    const requestId = request.request.id as RequestId;
    report.requestId = requestId;

    const started = Date.now();
    const generated = await generateGutenbergV2Candidate({
      siteId,
      requestId,
      target: { operation: "create_draft", postType: "post" }
    });
    report.generateMs = Date.now() - started;
    writeFileSync(
      join(artifactDirectory, "generated.json"),
      `${JSON.stringify(generated, null, 2)}\n`
    );
    if (!("state" in generated)) {
      throw new Error(`Generation failed: ${JSON.stringify(generated).slice(0, 4000)}`);
    }
    const state = gutenbergV2RequestStateSchema.parse(generated.state);
    if (!state.candidate) {
      throw new Error(
        `Generation produced no candidate (state ${state.state}): ${JSON.stringify(
          (state as { error?: unknown }).error ?? state
        ).slice(0, 6000)}`
      );
    }

    for (const reference of state.candidate.reviewArtifacts) {
      const artifact = await getGutenbergV2ReviewArtifact({
        siteId,
        requestId,
        artifactId: reference.id
      });
      if ("artifact" in artifact && artifact.artifact) {
        const extension =
          artifact.artifact.mimeType === "image/png" ? "png" : "json";
        writeFileSync(
          join(artifactDirectory, `review-${reference.id}.${extension}`),
          Buffer.from(artifact.artifact.dataBase64, "base64")
        );
      }
    }

    const decided = await decideGutenbergV2Candidate({
      siteId,
      requestId,
      candidateId: state.candidate.candidateId,
      decision: "approved"
    });
    if (!("state" in decided)) {
      throw new Error(`Approval failed: ${JSON.stringify(decided).slice(0, 2000)}`);
    }
    const executed = await executeGutenbergV2Candidate({ siteId, requestId });
    writeFileSync(
      join(artifactDirectory, "executed.json"),
      `${JSON.stringify(executed, null, 2)}\n`
    );
    if (!("state" in executed)) {
      throw new Error(`Execution failed: ${JSON.stringify(executed).slice(0, 4000)}`);
    }
    const finalState = gutenbergV2RequestStateSchema.parse(executed.state);
    assert(
      finalState.state === "succeeded",
      `Execution ended in ${finalState.state}: ${JSON.stringify(finalState).slice(0, 6000)}`
    );
    report.postId = finalState.result?.postId;
    report.outcome = "succeeded";
  } catch (error) {
    report.outcome = "failed";
    report.error = error instanceof Error ? error.message : String(error);
    process.exitCode = 1;
  } finally {
    configureGutenbergV2PlannerFactory(undefined);
    resetRuntimeContext();
    database.close();
    rmSync(runtimeDir, { recursive: true, force: true });
    writeFileSync(
      join(artifactDirectory, "report.json"),
      `${JSON.stringify(report, null, 2)}\n`
    );
    console.log(JSON.stringify({ ...report, artifacts: artifactDirectory }, null, 2));
  }
}

void main();
