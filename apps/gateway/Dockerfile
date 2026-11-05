# Build context is the repository root (see docker-compose.yml).
# Debian (glibc), not Alpine: the embedding runtime (onnxruntime) ships glibc binaries only.
FROM node:22-slim
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

# The embedding model is part of the image: no download at runtime, so a cold start (and a
# network-less deployment) still routes and caches with it. Its own layer, so code changes do not
# trigger another download.
ENV EMBEDDING_CACHE_DIR=/models
RUN node apps/gateway/dist/cli/fetchModel.js

ENV NODE_ENV=production
EXPOSE 8080
CMD ["node", "apps/gateway/dist/index.js"]
