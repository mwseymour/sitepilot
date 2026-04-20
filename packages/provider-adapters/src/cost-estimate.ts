import type { TokenUsage } from "./types.js";

/**
 * Rough per-million-token rates for telemetry only (not billing truth).
 * Unknown models fall back to the provider default row.
 */
const OPENAI_USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  default: { in: 0.15, out: 0.6 },
  "gpt-4o": { in: 2.5, out: 10 },
  "gpt-4o-mini": { in: 0.15, out: 0.6 }
};

const ANTHROPIC_USD_PER_MTOK: Record<string, { in: number; out: number }> = {
  default: { in: 3, out: 15 },
  "claude-3-5-sonnet-20241022": { in: 3, out: 15 },
  "claude-3-5-haiku-20241022": { in: 0.8, out: 4 }
};

function pickRates(
  table: Record<string, { in: number; out: number }>,
  model: string
): { in: number; out: number } {
  if (table[model]) {
    return table[model];
  }
  const prefix = Object.keys(table).find(
    (k) => k !== "default" && model.startsWith(k)
  );
  return prefix !== undefined ? table[prefix]! : table.default!;
}

export function estimateUsageCostUsd(
  provider: "openai" | "anthropic",
  model: string,
  usage: TokenUsage
): number {
  const rates =
    provider === "openai"
      ? pickRates(OPENAI_USD_PER_MTOK, model)
      : pickRates(ANTHROPIC_USD_PER_MTOK, model);
  return (
    (usage.inputTokens / 1_000_000) * rates.in +
    (usage.outputTokens / 1_000_000) * rates.out
  );
}
