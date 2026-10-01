import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * Links to review previews that open without signing in, so chat apps
 * (Codex, Claude Code, Slack) can show them. Each link is signed and expires
 * after 24 hours; anyone holding one can see that preview until then.
 */

const LINK_TTL_SECONDS = 24 * 60 * 60;

export type ReviewLinkTarget = { siteId: string; requestId: string; artifactId: string };

export function createReviewLinks(input: { secretsKey: Buffer; publicUrl: URL }) {
  // Its own key, derived from the secrets key, so a link can't be anything else.
  const key = createHmac("sha256", input.secretsKey).update("sitepilot review links v1").digest();
  const sign = (payload: string) => createHmac("sha256", key).update(payload).digest("base64url");

  return {
    url(target: ReviewLinkTarget, nowSeconds = Math.floor(Date.now() / 1000)): string {
      const payload = Buffer.from(
        JSON.stringify({ s: target.siteId, r: target.requestId, a: target.artifactId, e: nowSeconds + LINK_TTL_SECONDS })
      ).toString("base64url");
      return new URL(`/r/${payload}.${sign(payload)}`, input.publicUrl).toString();
    },

    verify(token: string, nowSeconds = Math.floor(Date.now() / 1000)): ReviewLinkTarget | null {
      const [payload, signature, extra] = token.split(".");
      if (!payload || !signature || extra !== undefined) return null;
      const expected = Buffer.from(sign(payload));
      const given = Buffer.from(signature);
      if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
      try {
        const fields = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
        if (typeof fields.s !== "string" || typeof fields.r !== "string" || typeof fields.a !== "string") return null;
        if (typeof fields.e !== "number" || fields.e < nowSeconds) return null;
        return { siteId: fields.s, requestId: fields.r, artifactId: fields.a };
      } catch {
        return null;
      }
    }
  };
}

export type ReviewLinks = ReturnType<typeof createReviewLinks>;
