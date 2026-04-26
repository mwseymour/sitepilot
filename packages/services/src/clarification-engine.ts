export type ClarificationAnalysis = {
  /** True when the prompt is too underspecified to plan safely. */
  needsClarification: boolean;
  /** Structured questions to show the operator when material is missing. */
  questions: string[];
  /** Warnings when the prompt looks like a duplicate or near-duplicate. */
  duplicateWarnings: string[];
};

type ClarificationAttachment = {
  fileName: string;
  mediaType: string;
};

function tokenize(s: string): Set<string> {
  return new Set((s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) as string[]);
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 1;
  }
  let inter = 0;
  for (const w of a) {
    if (b.has(w)) {
      inter++;
    }
  }
  const union = a.size + b.size - inter;
  return union === 0 ? 0 : inter / union;
}

function requestUsesExplicitFeaturedImageTerms(prompt: string): boolean {
  return /\b(featured image|thumbnail|post thumbnail)\b/i.test(prompt);
}

function requestUsesExplicitInlineImageTerms(prompt: string): boolean {
  return (
    /\binline\b/i.test(prompt) ||
    /\b(between|after|before)\b[\s\S]{0,40}\bparagraph\b/i.test(prompt) ||
    /\b(content area|body content|post body|inside the post|within the post|in the content|end of the content|top of the content)\b/i.test(
      prompt
    )
  );
}

function requestHasAmbiguousImageIntent(prompt: string): boolean {
  const mentionsImage =
    /\b(image|photo|picture|hero image|post image|page image)\b/i.test(prompt);
  const mentionsPageOrPost =
    /\b(post|page|article|homepage|home page|content)\b/i.test(prompt);
  const ambiguousPhrasing =
    /\b(set|update|change|add)\b[\s\S]{0,20}\b(post image|page image|image)\b/i.test(
      prompt
    ) || /\bhero image\b/i.test(prompt);

  return (
    mentionsImage &&
    mentionsPageOrPost &&
    ambiguousPhrasing &&
    !requestUsesExplicitFeaturedImageTerms(prompt) &&
    !requestUsesExplicitInlineImageTerms(prompt)
  );
}

function requestMentionsExistingBlockEdit(prompt: string): boolean {
  return /\b(change|update|edit|make|turn|convert|switch|replace|remove|delete|move)\b[\s\S]{0,40}\b(heading|title|image|photo|picture|paragraph|button|quote|list|table|block)\b/i.test(
    prompt
  );
}

function requestHasExplicitBlockLocator(prompt: string): boolean {
  const clarificationMatch = prompt.match(
    /\bClarification:\s*([^\n]+(?:\n(?!\n)[^\n]+)*)/i
  );
  const clarificationText = clarificationMatch?.[1]?.trim() ?? "";
  const clarificationTokens = (
    clarificationText.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []
  ).filter(
    (token) =>
      !new Set([
        "the",
        "this",
        "that",
        "it",
        "one",
        "block",
        "heading",
        "title",
        "image",
        "paragraph"
      ]).has(token)
  );

  return (
    /["'][^"']+["']/.test(prompt) ||
    (clarificationText.length > 0 &&
      (/["'][^"']+["']/.test(clarificationText) ||
        /\b(first|second|third|fourth|fifth|last|final|previous|next|newly added|just added|recently added)\b/i.test(
          clarificationText
        ) ||
        (/\b(heading|title|block)\b/i.test(clarificationText) &&
          clarificationTokens.length >= 1))) ||
    /\b(heading|title|block)\b[\s\S]{0,20}\b(with|text|called|named)\b[\s\S]{0,80}[a-z0-9][^\n]*[!?.,:]?/i.test(
      prompt
    ) ||
    /\b(first|second|third|fourth|fifth|last|final|previous|next|newly added|just added|recently added)\b/i.test(
      prompt
    ) ||
    /\b(after|before|between)\b[\s\S]{0,40}\b(paragraph|heading|image|photo|picture|button|quote|list|table|block)\b/i.test(
      prompt
    ) ||
    /\bparagraph\s+\d+\b/i.test(prompt) ||
    /\bh[1-6]\b[\s\S]{0,20}\b["'][^"']+["']/.test(prompt)
  );
}

function requestHasAmbiguousExistingBlockTarget(prompt: string): boolean {
  if (!requestMentionsExistingBlockEdit(prompt)) {
    return false;
  }

  if (requestHasExplicitBlockLocator(prompt)) {
    return false;
  }

  return /\b(the|this|that|it)\b[\s\S]{0,20}\b(heading|title|image|photo|picture|paragraph|button|quote|list|table|block)\b/i.test(
    prompt
  ) || /\bh[1-6]\b[\s\S]{0,20}\bheading\b/i.test(prompt);
}

function promptMentionsMediaIntent(prompt: string): boolean {
  return /\b(image|photo|picture|featured image|thumbnail|gallery|headshot|logo|screenshot)\b/i.test(
    prompt
  );
}

function requestHasAttachmentIntentMismatch(input: {
  prompt: string;
  attachments: ClarificationAttachment[];
}): boolean {
  if (input.attachments.length === 0) {
    return false;
  }

  if (promptMentionsMediaIntent(input.prompt)) {
    return false;
  }

  return /\b(add|insert|place|set|update|change)\b/i.test(input.prompt);
}

/**
 * Heuristic clarification and duplicate detection for typed requests (T22).
 * Deterministic and safe to unit test without a live model.
 */
export function analyzeClarification(input: {
  userPrompt: string;
  recentPromptsForSite: string[];
  attachments?: ClarificationAttachment[];
}): ClarificationAnalysis {
  const trimmed = input.userPrompt.trim();
  const wordCount = trimmed.split(/\s+/).filter(Boolean).length;
  const vague = trimmed.length < 12 || wordCount < 3;

  const questions: string[] = [];
  if (vague) {
    questions.push(
      "Which page, post, or URL should this apply to?",
      "What outcome do you want when this work is complete?"
    );
  }

  if (requestHasAmbiguousImageIntent(trimmed)) {
    questions.push(
      'Do you mean the featured image/thumbnail, or an inline image placed inside the post/page content?'
    );
  }

  if (requestHasAmbiguousExistingBlockTarget(trimmed)) {
    questions.push(
      "Which exact block should change? Quote the current text, or say something like the first/last matching heading or its position in the content."
    );
  }

  if (
    requestHasAttachmentIntentMismatch({
      prompt: trimmed,
      attachments: input.attachments ?? []
    })
  ) {
    questions.push(
      "You attached an image, but your request text does not mention using it. Should I use the attachment, or ignore it and only make the text change you asked for?"
    );
  }

  const duplicateWarnings: string[] = [];
  const curTokens = tokenize(trimmed);

  for (const prev of input.recentPromptsForSite) {
    if (prev.trim() === trimmed && trimmed.length > 0) {
      duplicateWarnings.push(
        "This prompt matches an earlier request on this site."
      );
      break;
    }
    const sim = jaccard(curTokens, tokenize(prev));
    if (sim >= 0.72) {
      duplicateWarnings.push(
        "This prompt is very similar to a recent request. Confirm that this is a new intent."
      );
      break;
    }
  }

  return {
    needsClarification: questions.length > 0,
    questions,
    duplicateWarnings
  };
}
