import { randomUUID } from "node:crypto";

import {
  SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES,
  requestVisualAnalysisSchema,
  type RequestVisualAnalysisPayload
} from "@sitepilot/contracts";
import type {
  ChatThreadId,
  Request,
  RequestId,
  RequestVisualAnalysis,
  RequestVisualAnalysisId,
  SiteId
} from "@sitepilot/domain";
import type { WorkspaceId } from "@sitepilot/domain";

import { getSecureStorage } from "./app-secure-storage.js";
import { getDatabase } from "./app-database.js";
import { loadPlannerPreferences } from "./planner-preferences-service.js";

type OpenAiInputPart =
  | { type: "text"; text: string }
  | { type: "image_url"; image_url: { url: string; detail: "high" } };

type OpenAiChatResponse = {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
};

type AnalyzeRequestVisualAnalysisResult =
  | { ok: true; analysis: RequestVisualAnalysisPayload }
  | { ok: false; code: string; message: string };

const MAX_ANALYSIS_IMAGES = 3;
type RequestWithImages = Request & {
  attachments?: NonNullable<Request["attachments"]>;
};

const VISUAL_ANALYSIS_JSON_SCHEMA = {
  name: "request_visual_analysis",
  strict: true,
  schema: {
    type: "object",
    additionalProperties: false,
    required: [
      "summary",
      "pageType",
      "layoutPattern",
      "styleNotes",
      "responsiveNotes",
      "regions",
      "mappingWarnings"
    ],
    properties: {
      summary: { type: "string", minLength: 1 },
      pageType: { type: "string", minLength: 1 },
      layoutPattern: { type: "string", minLength: 1 },
      styleNotes: {
        type: "array",
        items: { type: "string", minLength: 1 }
      },
      responsiveNotes: {
        type: "array",
        items: { type: "string", minLength: 1 }
      },
      regions: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "id",
            "label",
            "kind",
            "layout",
            "position",
            "contentSummary",
            "suggestedBlocks",
            "emphasis",
            "confidence"
          ],
          properties: {
            id: { type: "string", minLength: 1 },
            label: { type: "string", minLength: 1 },
            kind: { type: "string", minLength: 1 },
            layout: { type: "string", minLength: 1 },
            position: { type: "string", minLength: 1 },
            contentSummary: { type: "string", minLength: 1 },
            suggestedBlocks: {
              type: "array",
              minItems: 1,
              items: { type: "string", minLength: 1 }
            },
            emphasis: { type: "string", minLength: 1 },
            confidence: {
              type: "number",
              minimum: 0,
              maximum: 1
            }
          }
        }
      },
      mappingWarnings: {
        type: "array",
        items: { type: "string", minLength: 1 }
      }
    }
  }
} as const;

function nowIso(): string {
  return new Date().toISOString();
}

async function loadRequestContext(input: {
  siteId: SiteId;
  threadId: ChatThreadId;
  requestId: RequestId;
}): Promise<
  | {
      ok: true;
      request: RequestWithImages;
      workspaceId: WorkspaceId;
    }
  | { ok: false; code: string; message: string }
> {
  const db = getDatabase();
  const request = await db.repositories.requests.getById(input.requestId);
  if (!request || request.siteId !== input.siteId) {
    return {
      ok: false,
      code: "request_not_found",
      message: "Request not found for this site."
    };
  }
  if (request.threadId !== input.threadId) {
    return {
      ok: false,
      code: "thread_mismatch",
      message: "Request does not belong to this thread."
    };
  }

  const site = await db.repositories.sites.getById(input.siteId);
  if (!site) {
    return {
      ok: false,
      code: "site_not_found",
      message: "Site not found."
    };
  }

  return { ok: true, request, workspaceId: site.workspaceId };
}

function contractVisualAnalysisPayload(
  analysis: RequestVisualAnalysis
): RequestVisualAnalysisPayload {
  return requestVisualAnalysisSchema.parse({
    id: analysis.id,
    requestId: analysis.requestId,
    siteId: analysis.siteId,
    provider: analysis.provider,
    model: analysis.model,
    sourceImageCount: analysis.sourceImageCount,
    analyzedRequestUpdatedAt: analysis.analyzedRequestUpdatedAt,
    summary: analysis.summary,
    pageType: analysis.pageType,
    layoutPattern: analysis.layoutPattern,
    styleNotes: analysis.styleNotes,
    responsiveNotes: analysis.responsiveNotes,
    regions: analysis.regions,
    mappingWarnings: analysis.mappingWarnings,
    ...(analysis.reviewedAt !== undefined
      ? { reviewedAt: analysis.reviewedAt }
      : {}),
    createdAt: analysis.createdAt,
    updatedAt: analysis.updatedAt
  });
}

function buildUserContent(input: {
  requestPrompt: string;
  attachments: NonNullable<Request["attachments"]>;
}): OpenAiInputPart[] {
  return [
    {
      type: "text",
      text: JSON.stringify(
        {
          task:
            "Analyze the uploaded reference image(s) into a review manifest for later WordPress Gutenberg planning.",
          operatorRequest: input.requestPrompt
        },
        null,
        2
      )
    },
    ...input.attachments.slice(0, MAX_ANALYSIS_IMAGES).map((attachment) => ({
      type: "image_url" as const,
      image_url: {
        url: attachment.dataUrl,
        detail: "high" as const
      }
    }))
  ];
}

async function completeVisualAnalysis(input: {
  apiKey: string;
  model: string;
  requestPrompt: string;
  attachments: NonNullable<Request["attachments"]>;
}): Promise<{
  summary: string;
  pageType: string;
  layoutPattern: string;
  styleNotes: string[];
  responsiveNotes: string[];
  regions: RequestVisualAnalysisPayload["regions"];
  mappingWarnings: string[];
}> {
  const system = `You are SitePilot's screenshot layout analyst.
Convert uploaded reference screenshots or mockups into a strict JSON review manifest for later WordPress block planning.

Rules:
- Break the page into visually distinct regions from top to bottom.
- Suggest only these supported Gutenberg core blocks: ${SUPPORTED_WORDPRESS_CORE_BLOCK_NAMES.join(", ")}.
- Prefer the simplest faithful block mapping.
- When the design implies unsupported effects, preserve intent in plain language and mention the limitation in mappingWarnings.
- Do not invent unreadable text. Summarize unreadable text instead.
- Focus on structure and layout, not implementation details.
- Regions must be ordered top-to-bottom and suitable for operator review before planning.`;

  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${input.apiKey}`
    },
    body: JSON.stringify({
      model: input.model,
      messages: [
        { role: "system", content: system },
        {
          role: "user",
          content: buildUserContent({
            requestPrompt: input.requestPrompt,
            attachments: input.attachments
          })
        }
      ],
      response_format: {
        type: "json_schema",
        json_schema: VISUAL_ANALYSIS_JSON_SCHEMA
      }
    })
  });

  const body = (await res.json()) as OpenAiChatResponse;
  if (!res.ok) {
    throw new Error(
      body.error?.message ??
        `OpenAI screenshot analysis failed (${res.status}).`
    );
  }

  const raw = body.choices?.[0]?.message?.content ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error("Screenshot analysis returned non-JSON output.");
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Screenshot analysis JSON must be an object.");
  }

  const record = parsed as Record<string, unknown>;
  const summary =
    typeof record.summary === "string" ? record.summary.trim() : "";
  const pageType =
    typeof record.pageType === "string" ? record.pageType.trim() : "";
  const layoutPattern =
    typeof record.layoutPattern === "string"
      ? record.layoutPattern.trim()
      : "";
  const styleNotes = Array.isArray(record.styleNotes)
    ? record.styleNotes.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    : [];
  const responsiveNotes = Array.isArray(record.responsiveNotes)
    ? record.responsiveNotes.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    : [];
  const mappingWarnings = Array.isArray(record.mappingWarnings)
    ? record.mappingWarnings.filter(
        (value): value is string =>
          typeof value === "string" && value.trim().length > 0
      )
    : [];
  const regions = Array.isArray(record.regions)
    ? record.regions
    : [];

  if (
    summary.length === 0 ||
    pageType.length === 0 ||
    layoutPattern.length === 0 ||
    regions.length === 0
  ) {
    throw new Error("Screenshot analysis omitted required structural fields.");
  }

  return {
    summary,
    pageType,
    layoutPattern,
    styleNotes,
    responsiveNotes,
    regions: regions as RequestVisualAnalysisPayload["regions"],
    mappingWarnings
  };
}

export async function analyzeRequestVisualAnalysis(input: {
  siteId: SiteId;
  threadId: ChatThreadId;
  requestId: RequestId;
}): Promise<AnalyzeRequestVisualAnalysisResult> {
  const loaded = await loadRequestContext(input);
  if (!loaded.ok) {
    return loaded;
  }

  const attachments = loaded.request.attachments ?? [];
  if (attachments.length === 0) {
    return {
      ok: false,
      code: "request_missing_images",
      message: "Attach at least one image before running screenshot analysis."
    };
  }

  const storage = getSecureStorage();
  const apiKey = await storage.get({ namespace: "provider", keyId: "openai" });
  if (apiKey === undefined) {
    return {
      ok: false,
      code: "openai_not_configured",
      message:
        "Screenshot analysis requires an OpenAI API key in Settings."
    };
  }

  const prefs = await loadPlannerPreferences(storage, loaded.workspaceId);
  const model = prefs.openaiModel;

  let completed;
  try {
    completed = await completeVisualAnalysis({
      apiKey,
      model,
      requestPrompt: loaded.request.userPrompt,
      attachments
    });
  } catch (error) {
    return {
      ok: false,
      code: "visual_analysis_failed",
      message:
        error instanceof Error
          ? error.message
          : "Screenshot analysis failed."
    };
  }

  const ts = nowIso();
  const analysis: RequestVisualAnalysis = {
    id: randomUUID() as RequestVisualAnalysisId,
    requestId: loaded.request.id,
    siteId: loaded.request.siteId,
    provider: "openai",
    model,
    sourceImageCount: attachments.length,
    analyzedRequestUpdatedAt: loaded.request.updatedAt,
    summary: completed.summary,
    pageType: completed.pageType,
    layoutPattern: completed.layoutPattern,
    styleNotes: completed.styleNotes,
    responsiveNotes: completed.responsiveNotes,
    regions: completed.regions,
    mappingWarnings: completed.mappingWarnings,
    createdAt: ts,
    updatedAt: ts
  };

  await getDatabase().repositories.requestVisualAnalyses.save(analysis);

  return {
    ok: true,
    analysis: contractVisualAnalysisPayload(analysis)
  };
}

export async function reviewRequestVisualAnalysis(input: {
  siteId: SiteId;
  threadId: ChatThreadId;
  requestId: RequestId;
}): Promise<AnalyzeRequestVisualAnalysisResult> {
  const loaded = await loadRequestContext(input);
  if (!loaded.ok) {
    return loaded;
  }

  const existing = await getDatabase().repositories.requestVisualAnalyses.getByRequestId(
    input.requestId
  );
  if (!existing || existing.siteId !== input.siteId) {
    return {
      ok: false,
      code: "visual_analysis_missing",
      message: "Run screenshot analysis before approving it for planning."
    };
  }
  if (existing.analyzedRequestUpdatedAt < loaded.request.updatedAt) {
    return {
      ok: false,
      code: "visual_analysis_stale",
      message:
        "The request changed after the last screenshot analysis. Re-run analysis before approving it."
    };
  }

  const reviewed: RequestVisualAnalysis = {
    ...existing,
    reviewedAt: nowIso(),
    updatedAt: nowIso()
  };
  await getDatabase().repositories.requestVisualAnalyses.save(reviewed);

  return {
    ok: true,
    analysis: contractVisualAnalysisPayload(reviewed)
  };
}
