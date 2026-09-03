# Build context is the repo root:
#   docker build -f apps/api/Dockerfile .
FROM node:24-slim AS build
RUN corepack enable pnpm
WORKDIR /repo
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY apps/api/package.json apps/api/
COPY packages/shared/package.json packages/shared/
RUN pnpm install --frozen-lockfile --filter @teamup/api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter @teamup/api build

# Runtime: single bundled file, no node_modules, non-root user.
FROM node:24-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /repo/apps/api/dist/server.cjs ./server.cjs
COPY --from=build /repo/apps/api/seeds ./seeds
USER node
EXPOSE 8080
CMD ["node", "server.cjs"]
