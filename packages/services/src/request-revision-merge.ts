import type { ChatModelClient } from "@sitepilot/provider-adapters";

import { extractJsonObject } from "./json-extract.js";

const MERGE_SYSTEM_PROMPT = `You update a WordPress content request into one standalone specification.

Apply the follow-up to the current request and return JSON only:
{"updatedRequest":"<the full updated request>"}

Rules:
- Additive changes keep previous items and add the new ones.
- Removals or reductions change quantities or drop items. Do not leave "minus X" or the follow-up wording as a remaining item.
- Never replace the whole request with only the follow-up unless the user clearly asks to start over.
- Output the complete resulting request, not a patch list.

Examples:
Current: Create a post with 2 carrots.
Follow-up: also add 1 plum.
Updated: Create a post with 2 carrots and 1 plum.

Current: Create a post with 2 carrots and 1 plum.
Follow-up: actually take one carrot away.
Updated: Create a post with 1 carrot and 1 plum.`;

export function fallbackMergedRequestPrompt(
  currentPrompt: string,
  followUp: string
): string {
  return [
    currentPrompt.trim(),
    "",
    "Apply this change to the request above and keep one complete result. Keep earlier items unless this change reduces or removes them. Do not replace the whole request with only this change.",
    followUp.trim()
  ].join("\n");
}

function parseUpdatedRequest(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(extractJsonObject(text));
    if (
      parsed !== null &&
      typeof parsed === "object" &&
      !Array.isArray(parsed)
    ) {
      const updated = (parsed as { updatedRequest?: unknown }).updatedRequest;
      if (typeof updated === "string" && updated.trim().length > 0) {
        return updated.trim();
      }
    }
  } catch {
    return null;
  }
  return null;
}

export async function mergeRevisedRequestPrompt(input: {
  currentPrompt: string;
  followUp: string;
  client?: ChatModelClient;
  model?: string;
}): Promise<string> {
  const currentPrompt = input.currentPrompt.trim();
  const followUp = input.followUp.trim();
  if (currentPrompt.length === 0) {
    return followUp;
  }
  if (followUp.length === 0) {
    return currentPrompt;
  }
  if (input.client === undefined || input.model === undefined) {
    return fallbackMergedRequestPrompt(currentPrompt, followUp);
  }

  try {
    const result = await input.client.complete(
      [
        { role: "system", content: MERGE_SYSTEM_PROMPT },
        {
          role: "user",
          content: `Current request:\n${currentPrompt}\n\nFollow-up:\n${followUp}`
        }
      ],
      input.model
    );
    return (
      parseUpdatedRequest(result.text) ??
      fallbackMergedRequestPrompt(currentPrompt, followUp)
    );
  } catch {
    return fallbackMergedRequestPrompt(currentPrompt, followUp);
  }
}
