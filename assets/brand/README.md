# SitePilot logo

<img src="./sitepilot-mark.svg" width="96" alt="SitePilot logo">

The mark is an S drawn as a route, ending in a heading arrow. `sitepilot-mark.svg` is the source for every logo file. After changing it, run `npm run generate:brand-assets` from the repository root, which needs Playwright's Chromium (`npx playwright install chromium`).

## Colours

| Use     | Colour    |
| ------- | --------- |
| Tile    | `#0e6a61` |
| Route   | `#ffffff` |
| Heading | `#f2862e` |

The tile is the app's light-theme accent. The mark doesn't change between light and dark themes.

## Where it's used

| Place                                   | File                                                                                                                                       |
| --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Browser tab, desktop and hosted app     | `apps/desktop/public/favicon.ico`, `sitepilot-mark.svg` and `apple-touch-icon.png`, served at the server's root                            |
| App sidebar and home page               | `apps/desktop/public/sitepilot-mark.svg`                                                                                                   |
| Hosted sign-in, consent and other pages | Inline SVG in `apps/server/src/pages.ts`                                                                                                   |
| Desktop app icon                        | `apps/desktop/build/icon.icns` (macOS) and `icon.png` (Windows and Linux), read by electron-builder; `icon-macos.png` is the dev Dock icon |
| Claude, Codex and other MCP clients     | `packages/mcp-server/src/brand-icon.ts`, sent as the server's icon. claude.ai's connector list also shows the hosted server's favicon      |
| WordPress Settings and sign-in pages    | Inline SVG in `plugins/wordpress-sitepilot/includes/Admin/Brand.php`                                                                       |
| Slack app                               | `slack-app-icon.png`, uploaded by hand (below)                                                                                             |
| Directory listings and anything else    | `sitepilot-icon-512.png`                                                                                                                   |

The inline SVGs are copies of the source, so update them by hand when the mark changes.

## Slack

Slack's app manifest can't set an icon. In [api.slack.com/apps](https://api.slack.com/apps), open the SitePilot app, then go to **Basic Information**, then **Display Information**. Upload `slack-app-icon.png` as the app icon and set the background colour to `#0e6a61`. The square image is full-bleed because Slack rounds the corners itself.
