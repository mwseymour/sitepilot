export type RequestedPostTypeIntent =
  | { kind: "unspecified" }
  | { kind: "explicit"; postType: "post" | "page" }
  | { kind: "ambiguous" };

function hasPageMention(prompt: string): boolean {
  return /\bpages?\b/i.test(prompt);
}

function hasPostMention(prompt: string): boolean {
  return /\bposts?\b|\bblog post\b|\barticle\b/i.test(prompt);
}

function negatesPage(prompt: string): boolean {
  return /\bnot\s+(?:a\s+|the\s+)?pages?\b|\binstead of\s+(?:a\s+|the\s+)?pages?\b/i.test(
    prompt
  );
}

function negatesPost(prompt: string): boolean {
  return /\bnot\s+(?:a\s+|the\s+)?posts?\b|\binstead of\s+(?:a\s+|the\s+)?posts?\b/i.test(
    prompt
  );
}

export function detectRequestedPostTypeIntent(
  prompt: string
): RequestedPostTypeIntent {
  const mentionsPage = hasPageMention(prompt);
  const mentionsPost = hasPostMention(prompt);
  const rejectsPage = negatesPage(prompt);
  const rejectsPost = negatesPost(prompt);

  if (mentionsPage && !rejectsPage && (rejectsPost || !mentionsPost)) {
    return { kind: "explicit", postType: "page" };
  }

  if (mentionsPost && !rejectsPost && (rejectsPage || !mentionsPage)) {
    return { kind: "explicit", postType: "post" };
  }

  if (mentionsPage && mentionsPost) {
    if (rejectsPost && !rejectsPage) {
      return { kind: "explicit", postType: "page" };
    }

    if (rejectsPage && !rejectsPost) {
      return { kind: "explicit", postType: "post" };
    }

    return { kind: "ambiguous" };
  }

  if (mentionsPage) {
    return { kind: "explicit", postType: "page" };
  }

  if (mentionsPost) {
    return { kind: "explicit", postType: "post" };
  }

  return { kind: "unspecified" };
}
