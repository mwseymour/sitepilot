import {
  gutenbergV2TargetSchema,
  type SiteActivityThread,
  type SiteContentMatch
} from "@sitepilot/contracts";
import type { RequestStatus, SiteId, ThreadType } from "@sitepilot/domain";
import { normalizeMcpToolResult } from "@sitepilot/mcp-client";
import { SqliteGutenbergV2ExecutionJournal } from "@sitepilot/services";

import { getDatabase } from "./app-database.js";
import { createMcpClientForSite } from "./site-mcp-client.js";

type ActivityRow = {
  threadId: string;
  title: string;
  type: string;
  threadUpdatedAt: string;
  requestId: string | null;
  requestStatus: string | null;
  requestUpdatedAt: string | null;
  executionId: string | null;
  targetJson: string | null;
  executionUpdatedAt: string | null;
};

function journal(): SqliteGutenbergV2ExecutionJournal {
  return new SqliteGutenbergV2ExecutionJournal(getDatabase().connection);
}

function latest(...values: Array<string | null>): string {
  return values
    .filter((value): value is string => value !== null)
    .sort()
    .at(-1) as string;
}

/**
 * Recent threads with the state of their latest request, for the sidebar and
 * the site home. Reads only the local database, never the site.
 */
export async function getSiteActivitySummary(input: {
  siteId: SiteId;
  limit?: number;
}): Promise<
  | { ok: true; threads: SiteActivityThread[] }
  | { ok: false; code: string; message: string }
> {
  try {
    const rows = getDatabase()
      .connection.prepare<{ siteId: string; limit: number }, ActivityRow>(
        `SELECT t.id AS threadId, t.title, t.type, t.updated_at AS threadUpdatedAt,
                r.id AS requestId, r.status AS requestStatus, r.updated_at AS requestUpdatedAt,
                e.execution_id AS executionId, e.target_json AS targetJson,
                e.updated_at AS executionUpdatedAt
           FROM chat_threads t
           LEFT JOIN requests r ON r.id = (
             SELECT id FROM requests WHERE thread_id = t.id
             ORDER BY created_at DESC LIMIT 1
           )
           LEFT JOIN gutenberg_v2_request_executions e ON e.request_id = r.id
          WHERE t.site_id = @siteId AND t.archived_at IS NULL
          ORDER BY MAX(t.updated_at, COALESCE(r.updated_at, ''), COALESCE(e.updated_at, '')) DESC
          LIMIT @limit`
      )
      .all({ siteId: input.siteId, limit: input.limit ?? 20 });

    const jobs = journal();
    const threads: SiteActivityThread[] = [];
    for (const row of rows) {
      const job = row.executionId
        ? await jobs.get(row.executionId).catch(() => null)
        : null;
      const target = row.targetJson
        ? gutenbergV2TargetSchema.safeParse(JSON.parse(row.targetJson))
        : null;
      threads.push({
        threadId: row.threadId,
        title: row.title,
        type: row.type as ThreadType,
        updatedAt: latest(
          row.threadUpdatedAt,
          row.requestUpdatedAt,
          job?.updatedAt ?? row.executionUpdatedAt
        ),
        ...(row.requestId ? { requestId: row.requestId } : {}),
        ...(row.requestStatus
          ? { requestStatus: row.requestStatus as RequestStatus }
          : {}),
        ...(job ? { v2State: job.state } : {}),
        ...(target?.success ? { target: target.data } : {}),
        ...(job?.state === "approved" && job.approval
          ? { approvalExpiresAt: job.approval.expiresAt }
          : {})
      });
    }
    return { ok: true, threads };
  } catch (error) {
    return {
      ok: false,
      code: "activity_unavailable",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

/**
 * The current journal state of a request's v2 execution. Used to show live
 * progress while an apply is running, so it avoids starting a site runtime.
 */
export async function getGutenbergV2ExecutionProgress(input: {
  siteId: SiteId;
  requestId: string;
}) {
  const row = getDatabase()
    .connection.prepare<
      { siteId: string; requestId: string },
      { executionId: string }
    >(
      `SELECT execution_id AS executionId FROM gutenberg_v2_request_executions
        WHERE site_id = @siteId AND request_id = @requestId`
    )
    .get({ siteId: input.siteId, requestId: input.requestId });
  if (!row) return { ok: true as const, state: null, updatedAt: null };
  try {
    const job = await journal().get(row.executionId);
    return {
      ok: true as const,
      state: job?.state ?? null,
      updatedAt: job?.updatedAt ?? null
    };
  } catch (error) {
    return {
      ok: false as const,
      code: "progress_unavailable",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/**
 * Posts and pages matching a title, slug or ID, for the command palette.
 * Uses the plugin's read-only find-posts ability.
 */
export async function searchSiteContent(input: {
  siteId: SiteId;
  query: string;
}): Promise<
  | { ok: true; matches: SiteContentMatch[] }
  | { ok: false; code: string; message: string }
> {
  const mcp = await createMcpClientForSite(input.siteId);
  if (!mcp.ok) return { ok: false, code: mcp.code, message: mcp.message };

  const query = input.query.trim();
  const byId = /^#?(\d+)$/.exec(query);
  try {
    const raw = await mcp.client.callTool(
      byId ? "sitepilot-get-post" : "sitepilot-find-posts",
      byId
        ? { post_id: Number(byId[1]) }
        : {
            post_type: "any",
            status: "any",
            limit: 8,
            orderby: "modified",
            order: "DESC",
            ...(query.length > 0 ? { search: query } : {})
          }
    );
    const result = normalizeMcpToolResult(raw);
    const rows = byId
      ? result.post_id
        ? [result]
        : []
      : Array.isArray(result.matches)
        ? (result.matches as Record<string, unknown>[])
        : [];
    const matches = rows
      .map((row): SiteContentMatch | null => {
        const postId = Number(row.post_id);
        if (!Number.isInteger(postId) || postId <= 0) return null;
        return {
          postId,
          postType: text(row.post_type) || "post",
          status: text(row.post_status),
          title: text(row.post_title),
          slug: text(row.post_name),
          permalink: text(row.permalink),
          modifiedAt: text(row.modified_gmt)
        };
      })
      .filter((match): match is SiteContentMatch => match !== null)
      // Only posts and pages can be the target of a request.
      .filter((match) => match.postType === "post" || match.postType === "page");
    return { ok: true, matches };
  } catch (error) {
    return {
      ok: false,
      code: "search_failed",
      message: error instanceof Error ? error.message : String(error)
    };
  }
}
