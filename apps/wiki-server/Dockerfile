FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

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

ENV NODE_ENV=production

WORKDIR /repo/apps/wiki-server
EXPOSE 3100
CMD ["pnpm", "start"]
