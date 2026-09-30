// What a short follow-up may call the thread's post.
const OBJECT =
  "(?: (?:it|this|that|the (?:post|page)|this (?:post|page)|that (?:post|page)))?";
const POLITE = "(?: (?:now|please|for me))*";
const PUBLISH = new RegExp(
  `^(?:please )?(?:publish${OBJECT}|make${OBJECT} live|go live(?: with${OBJECT})?)${POLITE}$`
);
const UNPUBLISH = new RegExp(
  `^(?:please )?(?:unpublish${OBJECT}|take${OBJECT} (?:down|offline)|(?:revert|change|set|put)${OBJECT} (?:back )?(?:to|into) (?:a )?draft)${POLITE}$`
);

/**
 * A short follow-up that only asks to publish or unpublish the thread's
 * post. Anything else, such as "publish a new post about cats", is an
 * ordinary content request.
 */
export function gutenbergV2StatusIntent(
  text: string
): "publish" | "draft" | null {
  const normalized = text
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[.!]+$/, "")
    .trim();
  if (normalized.length === 0 || normalized.length > 60) return null;
  if (UNPUBLISH.test(normalized)) return "draft";
  if (PUBLISH.test(normalized)) return "publish";
  return null;
}
