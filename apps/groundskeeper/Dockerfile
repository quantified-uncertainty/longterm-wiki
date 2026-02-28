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

# Copy workspace manifests and lockfile first for layer caching
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
