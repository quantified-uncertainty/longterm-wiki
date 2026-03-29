FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /repo

# Copy workspace manifests and lockfile first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/wiki-server/package.json ./apps/wiki-server/
COPY packages/id-utils/package.json ./packages/id-utils/

# Install wiki-server and its workspace dependencies
RUN pnpm install --frozen-lockfile --filter wiki-server...

# Copy server source and workspace packages it depends on
COPY apps/wiki-server/ ./apps/wiki-server/
COPY packages/id-utils/ ./packages/id-utils/

ENV NODE_ENV=production

WORKDIR /repo/apps/wiki-server
EXPOSE 3100
CMD ["pnpm", "start"]
