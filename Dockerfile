# The Yuki service (docker-compose.yml, service `yuki`): the API and the web app on one port.
# The members' computer is the other container (apps/desktop); see docs/computer-container.md.
#   docker build --build-arg PUBLIC_API_URL=http://localhost:8787 -t yuki-service .
# BUILD_ID (optional) is the commit the web shows as its version (same as VITE_BUILD on a plain build).
FROM node:24-bookworm-slim AS build
RUN npm install -g pnpm@11.19.0
WORKDIR /app
COPY . .
# Dependencies of the service only (the phone app's workspace package is left out), then the
# server (tsc) and the web app, which is its own small project.
RUN pnpm install --frozen-lockfile --filter openmuse \
    && pnpm build:server
# The address the person's browser reaches the service at; it is built into the web app.
ARG PUBLIC_API_URL=http://localhost:8787
ARG BUILD_ID=
# WEB_INDEX_EXTRA (optional): a file of HTML put into the page source before </body>; by default
# apps/web/index-extra.html when the tree has one (docs/web.md).
ARG WEB_INDEX_EXTRA=
WORKDIR /app/apps/web
RUN pnpm install --frozen-lockfile \
    && VITE_API_URL="$PUBLIC_API_URL" VITE_BUILD="$BUILD_ID" WEB_INDEX_EXTRA="$WEB_INDEX_EXTRA" npx vite build --outDir /app/web-dist --emptyOutDir

FROM node:24-bookworm-slim
RUN apt-get update \
    && apt-get install -y --no-install-recommends openssl curl ca-certificates \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /data /keys \
    && chown 1000:1000 /data /keys
WORKDIR /app
COPY --from=build /app/package.json ./package.json
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/web-dist ./web
COPY --chmod=0555 docker/yuki-entrypoint.sh /usr/local/bin/yuki-entrypoint
ENV NODE_ENV=production HOST=0.0.0.0 PORT=8787 DATA_DIR=/data WEB_DIR=/app/web
USER 1000:1000
EXPOSE 8787
VOLUME ["/data", "/keys"]
HEALTHCHECK --interval=15s --timeout=3s --start-period=60s --retries=3 \
    CMD curl -fsS http://127.0.0.1:8787/api/health || exit 1
ENTRYPOINT ["/usr/local/bin/yuki-entrypoint"]
CMD ["node", "dist/apps/server/src/index.js"]
