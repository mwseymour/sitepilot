/**
 * Default redaction for structured logs, tool payloads, provider telemetry, and
 * errors. Keys are matched case-insensitively; values under sensitive keys are
 * replaced with a literal placeholder (never partially masked here).
 */

const SENSITIVE_SUBSTRINGS = [
  "password",
  "secret",
  "token",
  "apikey",
  "api_key",
  "authorization",
  "cookie",
  "set-cookie",
  "privatekey",
  "private_key",
  "credential",
  "signature"
] as const;

export function isSensitiveKey(key: string): boolean {
  const lower = key.toLowerCase();
  if (lower === "publickey" || lower === "public_key") {
    return false;
  }
  for (const fragment of SENSITIVE_SUBSTRINGS) {
    if (lower.includes(fragment)) {
      return true;
    }
  }
  return false;
}

const REDACTED = "[REDACTED]";

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || value === undefined) {
    return value;
  }
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean") {
    return value;
  }
  if (t === "bigint") {
    return value.toString();
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  if (t === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }
    seen.add(value);
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = redactValue(child, seen);
      }
    }
    return out;
  }
  return value;
}

/**
 * Returns a deep-cloned structure with sensitive keys redacted. Safe for
 * logging; does not mutate the input.
 */
export function redactStructuredData(value: unknown): unknown {
  return redactValue(value, new WeakSet<object>());
}
