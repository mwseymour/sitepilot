/**
 * Compatibility metadata for operator diagnostics and packaging (T35).
 */
export const SITEPILOT_PROTOCOL_VERSION = "1.0.0";

/** Minimum plugin protocol version the desktop app supports (semver-ish string). */
export const MIN_PLUGIN_PROTOCOL_VERSION = "1.0.0";

export function getCompatibilityPayload(input: {
  appVersion: string;
  electronVersion: string;
}) {
  return {
    appVersion: input.appVersion,
    electronVersion: input.electronVersion,
    sitepilotProtocolVersion: SITEPILOT_PROTOCOL_VERSION,
    minPluginProtocolVersion: MIN_PLUGIN_PROTOCOL_VERSION
  };
}
