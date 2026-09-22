import { createHash } from "node:crypto";

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .filter(([, child]) => child !== undefined)
        .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        .map(([key, child]) => [key, canonicalize(child)])
    );
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw new TypeError("Cannot hash a non-finite number.");
  }
  if (
    typeof value === "bigint" ||
    typeof value === "function" ||
    typeof value === "symbol"
  ) {
    throw new TypeError(`Cannot hash a ${typeof value} value.`);
  }
  return value;
}

export function canonicalGutenbergV2Json(value: unknown): string {
  const encoded = JSON.stringify(canonicalize(value));
  if (encoded === undefined) {
    throw new TypeError("Cannot hash an undefined value.");
  }
  return encoded;
}

export function hashGutenbergV2Value(value: unknown): string {
  return createHash("sha256")
    .update(canonicalGutenbergV2Json(value), "utf8")
    .digest("hex");
}

export function hashGutenbergV2Content(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex");
}

export function hashGutenbergV2Bytes(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}
