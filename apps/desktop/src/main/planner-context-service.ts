import { siteConfigSchema, type PlannerContext } from "@sitepilot/contracts";
import type { ChatThreadId, SiteId } from "@sitepilot/domain";

import { getDatabase } from "./app-database.js";
import { buildPlannerContext } from "@sitepilot/services";
import { loadPlannerSkillsForPrompt } from "./planner-skills-service.js";

export type BuildPlannerContextResult =
  | { ok: true; context: PlannerContext }
  | { ok: false; code: string; message: string };

async function loadLatestSiteConfigDocument(
  siteId: SiteId
): Promise<ReturnType<typeof siteConfigSchema.parse> | null> {
  const db = getDatabase();
  const versions = await db.repositories.siteConfigs.listVersions(siteId);
  const sorted = [...versions].sort((a, b) => b.version - a.version);
  const latest = sorted[0];
  if (!latest) {
    return null;
  }
  try {
    return siteConfigSchema.parse(latest.document);
  } catch {
    return null;
  }
}

function summarizeToolOutput(
  toolName: string,
  output: Record<string, unknown> | undefined
): string | null {
  if (!output) {
    return null;
  }

  const bits: string[] = [`Tool ${toolName} succeeded`];

  const postId = output["post_id"];
  if (typeof postId === "number" && Number.isFinite(postId) && postId > 0) {
    bits.push(`post_id=${postId}`);
  }

  const postType = output["post_type"];
  if (typeof postType === "string" && postType.trim().length > 0) {
    bits.push(`post_type=${postType}`);
  }

  const postStatus = output["post_status"];
  if (typeof postStatus === "string" && postStatus.trim().length > 0) {
    bits.push(`post_status=${postStatus}`);
  }

  const after = output["after"];
  if (after && typeof after === "object" && !Array.isArray(after)) {
    const record = after as Record<string, unknown>;
    const title = record["post_title"];
    if (typeof title === "string" && title.trim().length > 0) {
      bits.push(`current_title="${title.trim()}"`);
    }
  }

  const preview = output["preview"];
  if (preview && typeof preview === "object" && !Array.isArray(preview)) {
    const record = preview as Record<string, unknown>;
    const title = record["post_title"];
    if (typeof title === "string" && title.trim().length > 0) {
      bits.push(`preview_title="${title.trim()}"`);
    }
  }

  return bits.length > 1 ? bits.join("; ") : null;
}

export async function buildPlannerContextForThread(
  siteId: SiteId,
  threadId: ChatThreadId
): Promise<BuildPlannerContextResult> {
  const db = getDatabase();
  const site = await db.repositories.sites.getById(siteId);
  if (!site) {
    return { ok: false, code: "site_not_found", message: "Site not found." };
  }
  if (site.activationStatus !== "active") {
    return {
      ok: false,
      code: "site_not_active",
      message: "Site must be active to build planner context."
    };
  }

  const thread = await db.repositories.chatThreads.getById(threadId);
  if (!thread || thread.siteId !== siteId) {
    return {
      ok: false,
      code: "thread_not_found",
      message: "Thread not found for this site."
    };
  }

  const [siteConfig, discovery, messages, requests] = await Promise.all([
    loadLatestSiteConfigDocument(siteId),
    db.repositories.discoverySnapshots.getLatest(siteId),
    db.repositories.chatMessages.listByThreadId(threadId),
    db.repositories.requests.listByThreadId(threadId)
  ]);
  const activeSkills = await loadPlannerSkillsForPrompt(
    requests.at(-1)?.userPrompt ?? ""
  );

  const priorChanges: string[] = [];
  const targetSummaries: string[] = [];

  for (const request of requests) {
    if (
      request.siteId !== siteId ||
      request.latestExecutionRunId === undefined
    ) {
      continue;
    }

    const invocations = await db.repositories.toolInvocations.listByExecutionRunId(
      request.latestExecutionRunId
    );

    for (const invocation of invocations) {
      if (invocation.status !== "succeeded") {
        continue;
      }
      const summary = summarizeToolOutput(invocation.toolName, invocation.output);
      if (summary) {
        priorChanges.push(summary);
      }

      const postId = invocation.output?.["post_id"];
      if (
        typeof postId === "number" &&
        Number.isFinite(postId) &&
        postId > 0 &&
        invocation.toolName === "sitepilot-create-draft-post"
      ) {
        targetSummaries.push(
          `This thread previously created a draft post with post_id=${postId}. Reuse that post id for follow-up edits to the same draft.`
        );
      }
    }
  }

  const builtAt = new Date().toISOString();

  const context = buildPlannerContext({
    siteId,
    threadId,
    builtAt,
    siteConfig,
    discoverySnapshot: discovery,
    ...(activeSkills.length > 0 ? { activeSkills } : {}),
    messages,
    targetSummaries,
    priorChanges
  });

  return { ok: true, context };
}
