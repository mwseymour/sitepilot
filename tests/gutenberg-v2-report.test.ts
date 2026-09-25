import { describe, expect, it } from "vitest";

import {
  decisionReport,
  executionReport,
  failureReport,
  formatGutenbergV2Issue,
  friendlyFailureFallback,
  parsePlainLanguage,
  plainLanguagePrompt,
  requestNotices
} from "../apps/desktop/src/main/gutenberg-v2-report.js";

const target = {
  operation: "apply_operations" as const,
  postType: "post" as const,
  postId: 787
};

describe("Gutenberg v2 lifecycle reports", () => {
  it("formats an issue with its code, phase, block and position", () => {
    expect(
      formatGutenbergV2Issue({
        code: "invalid_block_markup",
        severity: "error",
        phase: "compile",
        message: "Block core/spacer failed Gutenberg validation.",
        blockName: "core/spacer",
        blockPath: [3, 0],
        planRef: "spacer-1",
        expected: '<div style="height:40px"></div>',
        actual: '<div style="height:40"></div>'
      })
    ).toBe(
      [
        '• [invalid_block_markup, compile] Block core/spacer failed Gutenberg validation. (core/spacer, position 4 › 1, plan ref "spacer-1")',
        '  expected: <div style="height:40px"></div>',
        '  actual: <div style="height:40"></div>'
      ].join("\n")
    );
  });

  it("explains a rejection with who, what and the reason", () => {
    const report = decisionReport({
      decision: "rejected",
      target,
      candidateId: "candidate-1",
      approverId: "local-operator"
    });
    expect(report).toContain("rejected by local-operator");
    expect(report).toContain("scoped changes to post #787");
    expect(report).toContain("Reason: no reason was given.");
    expect(report).toContain("Nothing was written.");
  });

  it("lists generation failure details for an admin", () => {
    const report = failureReport({
      stage: "generation",
      target: { operation: "create_draft", postType: "page" },
      executionId: "execution-1",
      error: {
        code: "planner_model_failed",
        message: "The plan failed strict validation.",
        issues: ["blocks.0.attributes.mediaRef: Unknown media ref"]
      }
    });
    expect(report).toContain("could not be generated: new page draft");
    expect(report).toContain("Reason (planner_model_failed)");
    expect(report).toContain(
      "• blocks.0.attributes.mediaRef: Unknown media ref"
    );
    expect(report).toContain("Execution execution-1.");
  });

  it("reports a failed verification with rollback and next step", () => {
    const report = executionReport({
      target,
      result: {
        schemaVersion: "sitepilot.execution-result/v2",
        executionId: "execution-2",
        idempotencyKey: "key-2",
        state: "rolled_back",
        postId: 787,
        createdMediaIds: [],
        retry: { retryable: false },
        rollback: { attempted: true, outcome: "succeeded" },
        auditRef: "audit-2"
      }
    });
    expect(report).toContain("was rolled back");
    expect(report).toContain("Rollback: succeeded.");
    expect(report).toContain("inspect the post in WordPress");
  });
});

describe("Gutenberg v2 request notices", () => {
  it("flags a request that mentions attached images when none were attached", () => {
    expect(
      requestNotices({
        prompt: "Start with the first attached image as a hero.",
        attachmentCount: 0
      })
    ).toEqual([expect.stringContaining("no images were attached")]);
    expect(
      requestNotices({
        prompt: "Start with the first attached image as a hero.",
        attachmentCount: 1
      })
    ).toEqual([]);
    expect(
      requestNotices({
        prompt: "Add an H2 and a paragraph.",
        attachmentCount: 0
      })
    ).toEqual([]);
  });
});

describe("Gutenberg v2 plain-language messages", () => {
  it("parses the model's plain-language explanation and rejects junk", () => {
    expect(
      parsePlainLanguage(
        '{"message": "The images were missing.  Nothing changed."}'
      )
    ).toBe("The images were missing. Nothing changed.");
    expect(parsePlainLanguage("not json")).toBeNull();
    expect(parsePlainLanguage('{"message": ""}')).toBeNull();
  });

  it("keeps developer terms out of the fallback and says nothing changed", () => {
    const text = friendlyFailureFallback({
      stage: "generation",
      target: { operation: "create_draft", postType: "post" },
      notices: [
        "The request refers to attached images, but no images were attached."
      ]
    });
    expect(text).toContain("Nothing on the site was changed.");
    expect(text).not.toMatch(/mediaRef|schema|planner|blocks\.\d/);
  });

  it("asks the model for JSON and forbids codes and IDs", () => {
    const prompt = plainLanguagePrompt("Reason (planner_model_failed): ...");
    expect(prompt).toContain('{"message": "..."}');
    expect(prompt).toContain("Do not include error codes, IDs");
  });
});
