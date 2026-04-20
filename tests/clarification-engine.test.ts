import { describe, expect, it } from "vitest";

import { analyzeClarification } from "@sitepilot/services";

describe("analyzeClarification", () => {
  it("flags vague prompts and emits questions", () => {
    const out = analyzeClarification({
      userPrompt: "fix",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(true);
    expect(out.questions.length).toBeGreaterThan(0);
  });

  it("warns on near-duplicate prompts", () => {
    const out = analyzeClarification({
      userPrompt: "Update the homepage hero title and subtitle for spring",
      recentPromptsForSite: [
        "Update the homepage hero title and subtitle for summer"
      ]
    });
    expect(out.duplicateWarnings.length).toBeGreaterThan(0);
  });

  it("passes clear prompts with no recent overlap", () => {
    const out = analyzeClarification({
      userPrompt:
        "On the About page, replace the team section with three new bios from the attached copy.",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(false);
    expect(out.duplicateWarnings).toHaveLength(0);
  });
});
