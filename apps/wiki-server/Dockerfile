FROM node:24.22.1-alpine AS build
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN apk upgrade --no-cache && corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /repo

# Copy workspace manifests and lockfile first for layer caching.
#
# IMPORTANT: `pnpm install` below fires the ROOT package.json's `postinstall`
# script before `crux/` (or any other source) is on disk. If that script
# references files not yet copied, the build crashes here — that's what broke
# the 2026-05-03 release (QUA-1053 / postmortem QUA-1081). Keep the root
# postinstall guarded with `if [ -f ... ]; then ...; fi`.
#
# See docs/agent-rules/dockerfile-postinstall-trap.md.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY patches/ ./patches/
COPY apps/wiki-server/package.json ./apps/wiki-server/
COPY packages/id-utils/package.json ./packages/id-utils/
COPY packages/factbase/package.json ./packages/factbase/
COPY packages/url-utils/package.json ./packages/url-utils/

# Install wiki-server and its workspace dependencies
RUN pnpm install --frozen-lockfile --filter wiki-server...

# Copy server source and workspace packages it depends on
COPY apps/wiki-server/ ./apps/wiki-server/
COPY packages/id-utils/ ./packages/id-utils/
COPY packages/factbase/ ./packages/factbase/
COPY packages/url-utils/ ./packages/url-utils/

# Copy the installed workspace without the build stage's package-manager caches.
FROM node:24.22.1-alpine AS runtime
RUN apk upgrade --no-cache && \
    rm -rf /usr/local/lib/node_modules/npm /usr/local/lib/node_modules/corepack && \
    rm -f /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack
COPY --from=build /repo /repo

ENV NODE_ENV=production

WORKDIR /repo/apps/wiki-server
EXPOSE 3100
CMD ["node", "--import", "tsx", "src/index.ts"]
