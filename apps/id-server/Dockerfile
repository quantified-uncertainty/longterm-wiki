FROM node:22-alpine AS base
ENV PNPM_HOME="/pnpm"
ENV PATH="$PNPM_HOME:$PATH"
RUN corepack enable && corepack prepare pnpm@9.15.4 --activate

WORKDIR /repo

# Copy workspace manifests and lockfile first for layer caching
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/id-server/package.json ./apps/id-server/

# Install only id-server dependencies
RUN pnpm install --frozen-lockfile --filter id-server

# Copy server source
COPY apps/id-server/ ./apps/id-server/

ENV NODE_ENV=production

WORKDIR /repo/apps/id-server
EXPOSE 3100
CMD ["pnpm", "start"]
