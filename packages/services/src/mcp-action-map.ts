function pickString(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.trim().length > 0) {
      return v;
    }
  }
  return undefined;
}

function pickNumber(
  input: Record<string, unknown>,
  ...keys: string[]
): number | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "number" && Number.isFinite(v)) {
      return v;
    }
    if (typeof v === "string" && v.trim().length > 0) {
      const n = Number.parseInt(v, 10);
      if (!Number.isNaN(n)) {
        return n;
      }
    }
  }
  return undefined;
}

function pickArray(
  input: Record<string, unknown>,
  ...keys: string[]
): unknown[] | undefined {
  for (const k of keys) {
    const v = input[k];
    if (Array.isArray(v)) {
      return v;
    }
  }
  return undefined;
}

function pickObject(
  input: Record<string, unknown>,
  ...keys: string[]
): Record<string, unknown> | undefined {
  for (const k of keys) {
    const v = input[k];
    if (v !== null && typeof v === "object" && !Array.isArray(v)) {
      return v as Record<string, unknown>;
    }
  }
  return undefined;
}

function pickStringFrom(
  inputs: Record<string, unknown>[],
  ...keys: string[]
): string | undefined {
  for (const input of inputs) {
    const value = pickString(input, ...keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pickArrayFrom(
  inputs: Record<string, unknown>[],
  ...keys: string[]
): unknown[] | undefined {
  for (const input of inputs) {
    const value = pickArray(input, ...keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

function pickNumberFrom(
  inputs: Record<string, unknown>[],
  ...keys: string[]
): number | undefined {
  for (const input of inputs) {
    const value = pickNumber(input, ...keys);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

export type McpToolCall = {
  toolName: string;
  arguments: Record<string, unknown>;
};

/**
 * Maps a persisted plan action to a SitePilot WordPress MCP tool (T28/T29).
 */
export function actionToMcpToolCall(
  actionType: string,
  input: Record<string, unknown>,
  dryRun: boolean
): McpToolCall | null {
  const t = actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();

  if (
    t === "interpret_request" ||
    t === "noop" ||
    t === "note" ||
    t === "comment"
  ) {
    return null;
  }

  if (
    t === "create_draft_post" ||
    t === "create_draft_content" ||
    t === "create_post_draft" ||
    t === "sitepilot_create_draft_post"
  ) {
    const nestedInput = pickObject(input, "input");
    const inputScopes =
      nestedInput !== undefined ? [input, nestedInput] : [input];
    const title = pickStringFrom(
      inputScopes,
      "title",
      "postTitle",
      "post_title"
    );
    if (!title) {
      return null;
    }
    const postType =
      pickStringFrom(inputScopes, "postType", "post_type") ?? "post";
    const content = pickStringFrom(
      inputScopes,
      "content",
      "postContent",
      "post_content"
    );
    const blocks = pickArrayFrom(
      inputScopes,
      "blocks",
      "contentBlocks",
      "content_blocks"
    );
    return {
      toolName: "sitepilot-create-draft-post",
      arguments: {
        post_type: postType,
        title,
        ...(content !== undefined ? { content } : {}),
        ...(blocks !== undefined ? { blocks } : {}),
        dry_run: dryRun
      }
    };
  }

  if (
    t === "update_post" ||
    t === "update_post_fields" ||
    t === "update_post_content" ||
    t === "edit_post_fields" ||
    t === "sitepilot_update_post_fields"
  ) {
    const nestedInput = pickObject(input, "input");
    const inputScopes =
      nestedInput !== undefined ? [input, nestedInput] : [input];
    const postId = pickNumberFrom(inputScopes, "postId", "post_id", "id");
    if (postId === undefined) {
      return null;
    }
    const args: Record<string, unknown> = {
      post_id: postId,
      dry_run: dryRun
    };
    const title = pickStringFrom(inputScopes, "title", "postTitle");
    const content = pickStringFrom(inputScopes, "content", "postContent");
    const blocks = pickArrayFrom(
      inputScopes,
      "blocks",
      "contentBlocks",
      "content_blocks"
    );
    const excerpt = pickStringFrom(inputScopes, "excerpt", "postExcerpt");
    if (title !== undefined) {
      args.title = title;
    }
    if (content !== undefined) {
      args.content = content;
    }
    if (blocks !== undefined) {
      args.blocks = blocks;
    }
    if (excerpt !== undefined) {
      args.excerpt = excerpt;
    }
    return {
      toolName: "sitepilot-update-post-fields",
      arguments: args
    };
  }

  if (
    t === "set_post_seo_meta" ||
    t === "seo_meta" ||
    t === "update_post_seo" ||
    t === "sitepilot_set_post_seo_meta"
  ) {
    const postId = pickNumber(input, "postId", "post_id", "id");
    if (postId === undefined) {
      return null;
    }
    const args: Record<string, unknown> = {
      post_id: postId,
      dry_run: dryRun
    };
    const seoTitle = pickString(input, "seoTitle", "seo_title", "metaTitle");
    const seoDescription = pickString(
      input,
      "seoDescription",
      "seo_description",
      "metaDescription"
    );
    if (seoTitle !== undefined) {
      args.seo_title = seoTitle;
    }
    if (seoDescription !== undefined) {
      args.seo_description = seoDescription;
    }
    return {
      toolName: "sitepilot-set-post-seo-meta",
      arguments: args
    };
  }

  return null;
}
