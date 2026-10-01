/**
 * True in the browser (the hosted app), where the API goes to the SitePilot
 * server instead of Electron. Desktop-only parts of the interface (adding
 * sites, provider keys, the local MCP server) are hidden there.
 */
export function isHostedApp(): boolean {
  return window.sitePilotHosted === true;
}
