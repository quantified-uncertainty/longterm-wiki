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
COPY patches/ ./patches/
COPY apps/discord-bot/package.json ./apps/discord-bot/

# Install only discord-bot dependencies
RUN pnpm install --frozen-lockfile --filter discord-bot

# Copy bot source (bot reads wiki content from wiki-server API, not local files)
COPY apps/discord-bot/ ./apps/discord-bot/

# Copy wiki content for /ask command file tools (MDX pages + YAML data).
# These are baked at build time; the wiki API tools provide live data.
COPY content/docs/ /wiki-content/content/docs/
COPY data/ /wiki-content/data/

ENV NODE_ENV=production
ENV WIKI_REPO_PATH=/wiki-content

WORKDIR /repo/apps/discord-bot
CMD ["pnpm", "start"]
