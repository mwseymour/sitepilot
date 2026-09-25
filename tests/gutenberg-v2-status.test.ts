import { describe, expect, it } from "vitest";

import {
  gutenbergV2BlockPlanSchema,
  gutenbergV2CompiledCandidateSchema
} from "@sitepilot/contracts";
import { hashGutenbergV2Value } from "@sitepilot/services";

import {
  friendlyCandidateReady,
  friendlyExecution
} from "../apps/desktop/src/main/gutenberg-v2-report.js";

const hash = "a".repeat(64);
const target = {
  postId: 42,
  postType: "post" as const,
  sourceRevision: "revision-1",
  sourceContentHash: hash,
  expectedFields: {}
};

function statusPlan(extra: Record<string, unknown> = {}) {
  return {
    schemaVersion: "sitepilot.block-plan/v2" as const,
    planId: "plan-1",
    siteId: "site-1",
    operation: "set_status" as const,
    target,
    status: { to: "publish" },
    media: [],
    ...extra
  };
}

function statusCandidate() {
  const plan = gutenbergV2BlockPlanSchema.parse(statusPlan());
  const intentHash = hashGutenbergV2Value(plan);
  return gutenbergV2CompiledCandidateSchema.parse({
    schemaVersion: "sitepilot.compiled-candidate/v2",
    candidateId: "candidate-1",
    planId: "plan-1",
    siteId: "site-1",
    operation: "set_status",
    intent: plan,
    requestedPostFields: {},
    serializedContent: "<!-- wp:paragraph --><p>Hi</p><!-- /wp:paragraph -->",
    contentHash: hash,
    intentHash,
    requestedFieldsHash: hash,
    sourceState: {
      postId: 42,
      revision: "revision-1",
      contentHash: hash,
      affectedFieldsHash: hash
    },
    capabilityFingerprint: hash,
    mediaManifest: [],
    mediaManifestHash: hash,
    validation: {
      outcome: "valid",
      expectedBlockCount: 0,
      observedBlockCount: 0,
      issues: [],
      contentPreservation: {
        passed: true,
        checked: [
          "text",
          "inline_markup",
          "links",
          "media",
          "captions",
          "ordering",
          "layout",
          "post_fields"
        ],
        intentHash,
        observedIntentHash: intentHash
      }
    },
    compiledAt: "2026-09-25T12:00:00.000Z"
  });
}

describe("status change plans", () => {
  it("accept publish and unpublish of an existing post", () => {
    expect(() => gutenbergV2BlockPlanSchema.parse(statusPlan())).not.toThrow();
    expect(() =>
      gutenbergV2BlockPlanSchema.parse(statusPlan({ status: { to: "draft" } }))
    ).not.toThrow();
  });

  it("never carry content, fields, media or other statuses", () => {
    for (const extra of [
      { status: { to: "future" } },
      { status: { to: "private" } },
      { postFields: { title: "Sneaky" } },
      { operations: [] },
      { blocks: [] },
      {
        media: [
          {
            ref: "m",
            source: {
              kind: "library_attachment",
              attachmentId: 5,
              checksum: hash
            },
            alt: ""
          }
        ]
      }
    ]) {
      expect(() =>
        gutenbergV2BlockPlanSchema.parse(statusPlan(extra))
      ).toThrow();
    }
  });

  it("need no review artifacts, unlike content candidates", () => {
    expect(() => statusCandidate()).not.toThrow();
  });
});

describe("status change messages", () => {
  const publish = {
    operation: "set_status" as const,
    postType: "post" as const,
    postId: 42,
    status: "publish" as const
  };

  it("say where the post will go live before approval", () => {
    const text = friendlyCandidateReady({
      target: publish,
      candidate: statusCandidate(),
      status: {
        title: "Opening hours",
        publicUrl: "https://example.test/opening-hours/"
      }
    });
    expect(text).toContain("Ready to publish post #42 “Opening hours”");
    expect(text).toContain(
      "it will be live at https://example.test/opening-hours/"
    );
    expect(text).toContain("the content stays as it is");
  });

  it("report the checked outcome and a rollback plainly", () => {
    const result = { postId: 42, state: "succeeded" } as Parameters<
      typeof friendlyExecution
    >[0]["result"];
    expect(friendlyExecution({ target: publish, result })).toContain(
      "is published, and SitePilot checked that it loads for visitors"
    );
    expect(
      friendlyExecution({
        target: publish,
        result: { ...result, state: "rolled_back" }
      })
    ).toContain(
      "didn't load for visitors, so SitePilot put it back to a draft"
    );
    expect(
      friendlyExecution({ target: { ...publish, status: "draft" }, result })
    ).toContain(
      "back to a draft, and SitePilot checked that it no longer loads"
    );
  });
});

describe("status change request state over IPC", () => {
  it("passes the desktop's IPC schema without review artifacts", async () => {
    const { gutenbergV2RequestStateSchema } = await import("@sitepilot/contracts");
    const candidate = statusCandidate();
    expect(() =>
      gutenbergV2RequestStateSchema.parse({
        requestId: "request-1",
        siteId: "site-1",
        executionId: "execution-1",
        target: { operation: "set_status", postType: "page", postId: 1677, status: "publish" },
        state: "review_ready",
        candidate: {
          candidateId: candidate.candidateId,
          planId: candidate.planId,
          operation: candidate.operation,
          contentHash: candidate.contentHash,
          intentHash: candidate.intentHash,
          capabilityFingerprint: candidate.capabilityFingerprint,
          sourceRevision: "revision-1",
          requestedPostFields: {},
          validation: candidate.validation,
          reviewArtifacts: []
        },
        createdAt: "2026-09-25T19:09:47.390Z",
        updatedAt: "2026-09-25T19:09:57.600Z"
      })
    ).not.toThrow();
  });
});
