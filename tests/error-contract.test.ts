import { describe, expect, it } from "vitest";

import { classifyErrorCode, parseWordPressError } from "@sitepilot/contracts";
import { workerErrorFromWordPress } from "@sitepilot/gutenberg-worker";
import {
  McpHttpError,
  isMcpToolError,
  normalizeMcpToolResult
} from "@sitepilot/mcp-client";

describe("sitepilot.error/v1 parsing", () => {
  it("trusts the cause and retry flag a current plugin sends", () => {
    const parsed = parseWordPressError(409, {
      code: "sitepilot_v2_stale_source",
      message: "The source content changed.",
      data: {
        status: 409,
        code: "stale_source",
        cause: "stale",
        retry_ok: false,
        details: { postId: 12 }
      }
    });
    expect(parsed).toEqual({
      code: "stale_source",
      cause: "stale",
      retryable: false,
      message: "The source content changed.",
      details: { postId: 12 },
      httpStatus: 409
    });
  });

  it("classifies known codes from older plugins that send no cause", () => {
    const parsed = parseWordPressError(503, {
      code: "sitepilot_v2_editor_unavailable",
      message: "Busy.",
      data: { status: 503, code: "editor_unavailable" }
    });
    expect(parsed.cause).toBe("host_environment");
    expect(parsed.retryable).toBe(true);
    expect(classifyErrorCode("sitepilot_v2_render_failed")).toEqual({
      cause: "render_failed",
      retryable: false
    });
  });

  it("never retries an unknown 4xx, and retries an unknown 5xx", () => {
    expect(
      parseWordPressError(400, { code: "rest_invalid_param", message: "No." })
        .retryable
    ).toBe(false);
    expect(parseWordPressError(502, "<html>Bad gateway</html>").retryable).toBe(
      true
    );
  });

  it("keeps the auth reason for diagnostics", () => {
    const parsed = parseWordPressError(401, {
      code: "sitepilot_permission_denied",
      message: "Signed requests only.",
      data: {
        status: 401,
        code: "permission_denied",
        cause: "auth",
        retry_ok: false,
        auth: { reason: "timestamp_outside_skew" }
      }
    });
    expect(parsed.auth).toEqual({ reason: "timestamp_outside_skew" });
    expect(new McpHttpError(401, "Unauthorized", JSON.stringify({
      code: "sitepilot_permission_denied",
      message: "Signed requests only.",
      data: { code: "permission_denied", auth: { reason: "nonce_replayed" } }
    })).message).toContain("nonce_replayed");
  });
});

describe("worker errors from WordPress", () => {
  it("maps an unknown refusal to a permanent wordpress_error", () => {
    const error = workerErrorFromWordPress(
      422,
      { code: "rest_no_route", message: "No route." },
      "fallback"
    );
    expect(error.code).toBe("wordpress_error");
    expect(error.retryable).toBe(false);
    expect(error.httpStatus).toBe(422);
  });

  it("maps an unknown server failure to a retryable editor_unavailable", () => {
    const error = workerErrorFromWordPress(500, undefined, "WordPress failed.");
    expect(error.code).toBe("editor_unavailable");
    expect(error.retryable).toBe(true);
    expect(error.message).toBe("WordPress failed.");
  });

  it("honours the plugin's retry flag for a known code", () => {
    const error = workerErrorFromWordPress(
      503,
      {
        message: "Tables aren't transactional.",
        data: {
          code: "conditional_commit_failed",
          cause: "host_environment",
          retry_ok: false
        }
      },
      "fallback"
    );
    expect(error.code).toBe("conditional_commit_failed");
    expect(error.retryable).toBe(false);
  });

  it("reads prepared_commit_changed as an idempotency conflict", () => {
    expect(
      workerErrorFromWordPress(
        409,
        { data: { code: "prepared_commit_changed" } },
        "fallback"
      ).code
    ).toBe("idempotency_conflict");
  });

  it("treats an unknown 401 as permission_denied for editor sessions", () => {
    const error = workerErrorFromWordPress(
      401,
      { code: "rest_forbidden" },
      "fallback",
      { authStatusMeansPermissionDenied: true }
    );
    expect(error.code).toBe("permission_denied");
    expect(error.retryable).toBe(false);
  });
});

describe("MCP tool errors", () => {
  it("keeps the error flag when normalizing a tool result", () => {
    const raw = {
      isError: true,
      content: [{ type: "text", text: "Post not found." }]
    };
    expect(isMcpToolError(raw)).toBe(true);
    expect(normalizeMcpToolResult(raw)).toEqual({
      raw: "Post not found.",
      isError: true
    });
    expect(isMcpToolError({ content: [] })).toBe(false);
  });
});
