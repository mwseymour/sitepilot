/**
 * Normalize incoming HTTP-style headers to a flat lowercase map (first value wins).
 */
export function normalizeHeaderMap(
  headers: Record<string, string | string[] | undefined>
): Record<string, string> {
  const merged: Record<string, string> = {};
  for (const [rawKey, rawValue] of Object.entries(headers)) {
    if (rawValue === undefined) {
      continue;
    }
    const key = rawKey.toLowerCase();
    const value = Array.isArray(rawValue) ? rawValue[0] : rawValue;
    if (value === undefined) {
      continue;
    }
    if (!(key in merged)) {
      merged[key] = value;
    }
  }
  return merged;
}
