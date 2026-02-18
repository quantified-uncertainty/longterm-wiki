FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /repo

# Copy workspace manifests and lockfile first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/discord-bot/package.json ./apps/discord-bot/

# Install only discord-bot dependencies
RUN pnpm install --frozen-lockfile --filter discord-bot

# Copy bot source and wiki content (bot reads content/docs/ at runtime)
COPY apps/discord-bot/ ./apps/discord-bot/
COPY content/ ./content/

# WIKI_ROOT defaults to three levels up from apps/discord-bot/src/ = /repo
# Override via env var if needed
ENV NODE_ENV=production

WORKDIR /repo/apps/discord-bot
CMD ["pnpm", "start"]
