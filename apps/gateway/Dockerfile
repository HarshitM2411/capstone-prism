# Build context is the repository root (see docker-compose.yml).
FROM node:22-alpine
RUN npm install -g pnpm@12.16.1
WORKDIR /repo

# Install dependencies first so this layer is cached until a manifest changes.
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/console/package.json apps/console/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/gateway apps/gateway
RUN pnpm --filter @prism/shared-types --filter @prism/gateway build

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/gateway/dist/index.js"]
