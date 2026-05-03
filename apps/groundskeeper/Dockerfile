FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

# Install system dependencies needed for Claude Code and git operations
RUN apk add --no-cache git github-cli openssh

# Install Claude Code CLI globally (needed for Phase 2+ AI tasks)
# Pin version to avoid silent breakage from upstream updates
RUN npm install -g @anthropic-ai/claude-code@2.1.63

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
COPY apps/groundskeeper/package.json ./apps/groundskeeper/

# Install only groundskeeper dependencies
RUN pnpm install --frozen-lockfile --filter groundskeeper

# Copy groundskeeper source
COPY apps/groundskeeper/ ./apps/groundskeeper/

# Create data directory for run log
RUN mkdir -p /data

ENV NODE_ENV=production

WORKDIR /repo/apps/groundskeeper
CMD ["pnpm", "start"]
