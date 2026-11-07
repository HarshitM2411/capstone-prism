# Build context is the repository root (see docker-compose.yml).
FROM node:22-alpine AS build
RUN npm install -g pnpm@12.16.1
WORKDIR /repo

COPY package.json pnpm-workspace.yaml pnpm-lock.yaml ./
COPY apps/gateway/package.json apps/gateway/
COPY apps/console/package.json apps/console/
COPY packages/shared-types/package.json packages/shared-types/
RUN pnpm install --frozen-lockfile

COPY tsconfig.base.json ./
COPY packages packages
COPY apps/console apps/console
RUN pnpm --filter @prism/console build

FROM nginx:1.27-alpine
COPY apps/console/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /repo/apps/console/dist /usr/share/nginx/html
EXPOSE 80
