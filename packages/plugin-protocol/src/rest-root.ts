/**
 * Where a site's REST API lives. Most sites serve it at /wp-json/, but a
 * host without URL rewriting serves it at /index.php/wp-json/ (or only at
 * ?rest_route=). Signed requests must use the exact URL WordPress reports
 * with rest_url(), so SitePilot learns each site's REST root from the
 * plugin's /protocol answer and builds every REST URL from it.
 */

const roots = new Map<string, string>();

function siteKey(siteBaseUrl: string): string {
  return siteBaseUrl.replace(/\/+$/, "");
}

/** /protocol, reachable on any permalink setting. */
export function protocolDiscoveryUrl(siteBaseUrl: string): string {
  return `${siteKey(siteBaseUrl)}/?rest_route=/sitepilot/v1/protocol`;
}

/**
 * The REST root from the plugin's /protocol answer: its v2.base_route is
 * rest_url('sitepilot/v2'), so the root is everything before that route.
 */
export function restRootFromProtocol(protocol: unknown): string | null {
  const baseRoute = (protocol as { v2?: { base_route?: unknown } } | null)?.v2?.base_route;
  if (typeof baseRoute !== "string") return null;
  const index = baseRoute.lastIndexOf("sitepilot/v2");
  return index > 0 ? baseRoute.slice(0, index) : null;
}

export function rememberSiteRestRoot(siteBaseUrl: string, restRoot: string): void {
  roots.set(siteKey(siteBaseUrl), restRoot);
}

export function knowsSiteRestRoot(siteBaseUrl: string): boolean {
  return roots.has(siteKey(siteBaseUrl));
}

/** A REST URL on the site, e.g. siteRestUrl(base, "sitepilot/v2/prepare"). */
export function siteRestUrl(siteBaseUrl: string, route: string): string {
  const root = roots.get(siteKey(siteBaseUrl)) ?? `${siteKey(siteBaseUrl)}/wp-json/`;
  return `${root}${route.replace(/^\/+/, "")}`;
}
