# SitePilot's hosted server. Build context: the repository root.
FROM node:22-bookworm-slim

WORKDIR /app
ENV NODE_ENV=production \
    ELECTRON_SKIP_BINARY_DOWNLOAD=1 \
    PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1 \
    npm_config_audit=false \
    npm_config_fund=false \
    npm_config_fetch_retries=5

COPY . .
# The workspace installs as a whole. Install scripts are skipped: the server
# needs none of the desktop's native modules or downloads.
RUN npm ci --ignore-scripts --include=dev \
  && npx tsc -b apps/server/tsconfig.json

USER node
EXPOSE 8080
CMD ["node", "apps/server/dist/index.js"]
