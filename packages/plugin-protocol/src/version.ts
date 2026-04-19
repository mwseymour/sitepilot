export type ProtocolVersionParts = {
  major: number;
  minor: number;
  patch: number;
};

export function parseProtocolVersion(
  version: string
): ProtocolVersionParts | null {
  const trimmed = version.trim();
  const parts = trimmed.split(".");
  if (parts.length !== 3) {
    return null;
  }
  const major = Number.parseInt(parts[0] ?? "", 10);
  const minor = Number.parseInt(parts[1] ?? "", 10);
  const patch = Number.parseInt(parts[2] ?? "", 10);
  if ([major, minor, patch].some((n) => Number.isNaN(n))) {
    return null;
  }
  return { major, minor, patch };
}

export type CompatibilityResult = { ok: true } | { ok: false; reason: string };

/**
 * `pluginProtocolVersion` is what the WordPress plugin reports; `appProtocolVersion`
 * is what the desktop app supports. The plugin must not require a newer
 * protocol than the app (same major; plugin semver must be <= app semver).
 */
export function compareProtocolCompatibility(
  pluginProtocolVersion: string,
  appProtocolVersion: string
): CompatibilityResult {
  const plugin = parseProtocolVersion(pluginProtocolVersion);
  const app = parseProtocolVersion(appProtocolVersion);
  if (!plugin) {
    return { ok: false, reason: "invalid_plugin_protocol_version" };
  }
  if (!app) {
    return { ok: false, reason: "invalid_app_protocol_version" };
  }
  if (plugin.major !== app.major) {
    return { ok: false, reason: "protocol_major_mismatch" };
  }
  if (plugin.minor > app.minor) {
    return { ok: false, reason: "plugin_requires_newer_minor" };
  }
  if (plugin.minor === app.minor && plugin.patch > app.patch) {
    return { ok: false, reason: "plugin_requires_newer_patch" };
  }
  return { ok: true };
}
