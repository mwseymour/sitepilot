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

  it("asks for clarification when image intent is ambiguous", () => {
    const out = analyzeClarification({
      userPrompt: "Set the post image on the homepage",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(true);
    expect(out.questions).toContain(
      "Do you mean the featured image/thumbnail, or an inline image placed inside the post/page content?"
    );
  });

  it("does not ask for clarification when featured image intent is explicit", () => {
    const out = analyzeClarification({
      userPrompt: "Set the featured image on post 60",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(false);
  });

  it("does not ask for clarification when inline image placement is explicit", () => {
    const out = analyzeClarification({
      userPrompt: "Add this image at the end of the content area in post 60",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(false);
  });

  it("treats explicit inline clarification answers as resolving the ambiguity", () => {
    const out = analyzeClarification({
      userPrompt:
        "Set the post image on the homepage\n\nClarification:\ninline - between paragraphs 3 and 4",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(false);
  });

  it("asks for clarification when a heading edit does not identify the target block", () => {
    const out = analyzeClarification({
      userPrompt: "Change the H2 heading to a h3",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(true);
    expect(out.questions).toContain(
      "Which exact block should change? Quote the current text, or say something like the first/last matching heading or its position in the content."
    );
  });

  it("does not ask for clarification when the heading edit identifies the heading text", () => {
    const out = analyzeClarification({
      userPrompt: "Change the heading 'New heading!' to an h3",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(false);
  });

  it("treats unquoted heading text in a clarification answer as a resolved block target", () => {
    const out = analyzeClarification({
      userPrompt:
        "change the heading from h2 to h3\n\nClarification:\nthe one heading H2 with New heading!",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(false);
  });

  it("treats a plain heading-text clarification answer as a resolved block target", () => {
    const out = analyzeClarification({
      userPrompt:
        "Change the hello me heading from h2 to h4\n\nClarification:\nhello me heading",
      recentPromptsForSite: []
    });
    expect(out.needsClarification).toBe(false);
  });

  it("asks for clarification when an image is attached but the prompt asks for a non-image edit", () => {
    const out = analyzeClarification({
      userPrompt: "Now add a heading after paragraph 2 'New heading!'",
      recentPromptsForSite: [],
      attachments: [
        {
          fileName: "medium-widget-1.png",
          mediaType: "image/png"
        }
      ]
    });
    expect(out.needsClarification).toBe(true);
    expect(out.questions).toContain(
      "You attached an image, but your request text does not mention using it. Should I use the attachment, or ignore it and only make the text change you asked for?"
    );
  });

  it("does not ask for attachment clarification when the prompt explicitly uses the image", () => {
    const out = analyzeClarification({
      userPrompt: "Now add this image after the heading we just added",
      recentPromptsForSite: [],
      attachments: [
        {
          fileName: "medium-widget-1.png",
          mediaType: "image/png"
        }
      ]
    });
    expect(out.needsClarification).toBe(false);
  });
});
