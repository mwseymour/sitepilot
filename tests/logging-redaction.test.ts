import { describe, expect, it, vi } from "vitest";

import {
  createLogger,
  redactStructuredData,
  type LogRecord
} from "@sitepilot/logging";

describe("logging redaction", () => {
  it("redacts sensitive keys in nested structures", () => {
    const input = {
      requestId: "r1",
      provider: { apiKey: "super-secret", model: "gpt-4" },
      headers: { Authorization: "Bearer x" }
    };
    const redacted = redactStructuredData(input) as Record<string, unknown>;
    expect(redacted.requestId).toBe("r1");
    expect(redacted.provider).toEqual({
      apiKey: "[REDACTED]",
      model: "gpt-4"
    });
    expect(redacted.headers).toEqual({ Authorization: "[REDACTED]" });
  });

  it("preserves public keys and non-sensitive fields", () => {
    const input = {
      publicKey: "pk-test",
      fingerprint: "fp-1",
      nested: { token: "hide-me", label: "ok" }
    };
    const redacted = redactStructuredData(input) as Record<string, unknown>;
    expect(redacted.publicKey).toBe("pk-test");
    expect(redacted.fingerprint).toBe("fp-1");
    expect((redacted.nested as Record<string, unknown>).label).toBe("ok");
    expect((redacted.nested as Record<string, unknown>).token).toBe(
      "[REDACTED]"
    );
  });

  it("emits redacted JSON logs by default", () => {
    const records: LogRecord[] = [];
    const logger = createLogger("test.ns", {
      sink(record) {
        records.push(record);
      }
    });

    logger.info("tool call", {
      tool: "wp.search",
      args: { apiKey: "abc" }
    });

    expect(records).toHaveLength(1);
    const ctx = records[0]?.context as Record<string, unknown> | undefined;
    expect(ctx?.tool).toBe("wp.search");
    expect((ctx?.args as Record<string, unknown>).apiKey).toBe("[REDACTED]");
  });

  it("merges child bindings and redacts", () => {
    const records: LogRecord[] = [];
    const logger = createLogger("parent", {
      sink(record) {
        records.push(record);
      },
      bindings: { siteId: "s1" }
    });

    const child = logger.child({ requestId: "req-9" });
    child.error("failed", { refreshToken: "rt" });

    expect(records[0]?.context).toEqual({
      siteId: "s1",
      requestId: "req-9",
      refreshToken: "[REDACTED]"
    });
  });

  it("passes errors through with structured record", () => {
    const records: LogRecord[] = [];
    const logger = createLogger("err", {
      sink(record) {
        records.push(record);
      }
    });
    const err = new Error("boom");
    logger.error("x", { step: "a" }, err);
    expect(records[0]?.error?.message).toBe("boom");
    expect(records[0]?.level).toBe("error");
  });
});

describe("default sink", () => {
  it("writes to console methods", () => {
    const debug = vi.spyOn(console, "debug").mockImplementation(() => {});
    const logger = createLogger("sink-test");
    logger.debug("ping");
    expect(debug).toHaveBeenCalled();
    debug.mockRestore();
  });
});
