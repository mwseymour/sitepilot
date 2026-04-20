export type ClarificationAnalysis = {
  /** True when the prompt is too underspecified to plan safely. */
  needsClarification: boolean;
  /** Structured questions to show the operator when material is missing. */
  questions: string[];
  /** Warnings when the prompt looks like a duplicate or near-duplicate. */
  duplicateWarnings: string[];
};

function tokenize(s: string): Set<string> {
  return new Set(
    (s.toLowerCase().match(/[a-z0-9]{2,}/g) ?? []) as string[]
  );
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

/**
 * Heuristic clarification and duplicate detection for typed requests (T22).
 * Deterministic and safe to unit test without a live model.
 */
export function analyzeClarification(input: {
  userPrompt: string;
  recentPromptsForSite: string[];
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
