/**
 * Pulls a JSON object from model output, including ```json fences``` if present.
 */
export function extractJsonObject(text: string): string {
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) {
    return fence[1].trim();
  }
  return text.trim();
}
