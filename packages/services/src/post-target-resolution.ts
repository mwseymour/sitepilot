function normalizeActionType(actionType: string): string {
  return actionType
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[\s/_-]+/g, "_")
    .toLowerCase();
}

function pickString(
  input: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const k of keys) {
    const v = input[k];
    if (typeof v === "string" && v.trim().length > 0) {
      return v.trim();
    }
  }
  return undefined;
}

export function findNumericPostId(
  input: Record<string, unknown>
): number | undefined {
  const candidates = [input["post_id"], input["postId"], input["id"]];
  for (const value of candidates) {
    if (typeof value === "number" && Number.isFinite(value) && value > 0) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number.parseInt(value, 10);
      if (!Number.isNaN(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return undefined;
}

export function actionSupportsPostLookup(actionType: string): boolean {
  const t = normalizeActionType(actionType);
  return (
    t === "update_post_fields" ||
    t === "update_post_content" ||
    t === "edit_post_fields" ||
    t === "sitepilot_update_post_fields" ||
    t === "set_post_seo_meta" ||
    t === "sitepilot_set_post_seo_meta"
  );
}

export function buildPostLookupArguments(
  input: Record<string, unknown>
): Record<string, unknown> | null {
  if (findNumericPostId(input) !== undefined) {
    return null;
  }

  const postType = pickString(
    input,
    "lookup_post_type",
    "lookupPostType",
    "target_post_type",
    "targetPostType",
    "post_type",
    "postType"
  );
  const status = pickString(
    input,
    "lookup_status",
    "lookupStatus",
    "target_status",
    "targetStatus",
    "post_status",
    "postStatus",
    "status"
  );
  const slug = pickString(
    input,
    "lookup_slug",
    "lookupSlug",
    "target_slug",
    "targetSlug",
    "post_name",
    "postSlug",
    "slug"
  );
  const title = pickString(
    input,
    "lookup_title",
    "lookupTitle",
    "target_title",
    "targetTitle",
    "existing_title",
    "existingTitle"
  );
  const search = pickString(
    input,
    "lookup_search",
    "lookupSearch",
    "target_search",
    "targetSearch",
    "search",
    "query"
  );

  if (
    postType === undefined &&
    status === undefined &&
    slug === undefined &&
    title === undefined &&
    search === undefined
  ) {
    return null;
  }

  return {
    ...(postType !== undefined ? { post_type: postType } : {}),
    ...(status !== undefined ? { status } : {}),
    ...(slug !== undefined ? { slug } : {}),
    ...(title !== undefined ? { title } : {}),
    ...(search !== undefined ? { search } : {}),
    limit: 2
  };
}

export function canResolveActionViaPostLookup(
  actionType: string,
  input: Record<string, unknown>
): boolean {
  return (
    actionSupportsPostLookup(actionType) &&
    findNumericPostId(input) === undefined &&
    buildPostLookupArguments(input) !== null
  );
}

export function resolvePostIdFromLookupResult(result: Record<string, unknown>): {
  ok: true;
  postId: number;
} | {
  ok: false;
  code: "post_lookup_no_match" | "post_lookup_ambiguous";
  message: string;
} {
  const matches = result["matches"];
  if (!Array.isArray(matches) || matches.length === 0) {
    return {
      ok: false,
      code: "post_lookup_no_match",
      message: "No matching post was found for the requested target."
    };
  }

  const totalMatches = result["total_matches"];
  if (
    (typeof totalMatches === "number" && totalMatches !== 1) ||
    matches.length !== 1
  ) {
    return {
      ok: false,
      code: "post_lookup_ambiguous",
      message:
        "The requested target matched more than one post. Add a slug or a more specific filter."
    };
  }

  const first = matches[0];
  if (first === null || typeof first !== "object" || Array.isArray(first)) {
    return {
      ok: false,
      code: "post_lookup_no_match",
      message: "No matching post was found for the requested target."
    };
  }

  const postId = (first as Record<string, unknown>)["post_id"];
  if (typeof postId !== "number" || !Number.isFinite(postId) || postId <= 0) {
    return {
      ok: false,
      code: "post_lookup_no_match",
      message: "No matching post was found for the requested target."
    };
  }

  return { ok: true, postId };
}
