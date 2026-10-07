# Single image: builds the web app, serves it from the Node server.
# better-sqlite3 is a native addon, so the builder needs a toolchain; the
# runtime image only needs the compiled module.
FROM node:22-bookworm-slim AS base
RUN corepack enable && corepack prepare pnpm@12.9.1 --activate
WORKDIR /app

FROM base AS deps
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/contracts/package.json packages/contracts/
COPY apps/server/package.json apps/server/
COPY apps/web/package.json apps/web/
RUN pnpm install --frozen-lockfile

FROM deps AS build
COPY . .
RUN pnpm exec vp -C apps/web build

FROM base AS runtime
ENV NODE_ENV=production
COPY --from=deps /app/node_modules ./node_modules
COPY --from=deps /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=deps /app/apps/web/node_modules ./apps/web/node_modules
COPY --from=deps /app/packages/contracts/node_modules ./packages/contracts/node_modules
COPY --from=build /app/apps/web/dist ./apps/web/dist
COPY package.json pnpm-workspace.yaml tsconfig.json ./
COPY packages ./packages
COPY apps/server ./apps/server

WORKDIR /app/apps/server
EXPOSE 3000
# The app runs migrations at startup, then serves the API and the built SPA.
# Invoke the workspace-local tsx binary directly: `pnpm exec` would notice the
# store metadata is absent (it is not copied into the runtime image) and trigger
# a full re-install at container start, which needs the network and stalls.
CMD ["./node_modules/.bin/tsx", "src/main.ts"]
