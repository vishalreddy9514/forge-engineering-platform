# syntax=docker/dockerfile:1.7
# Forge API and worker (one image, two commands), plus a `migrate` target for schema changes.
# Build from the repository root: docker build -f apps/api/Dockerfile .

FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH CI=true
RUN corepack enable
WORKDIR /repo

# ---- Install and build (dev dependencies included) ----
FROM base AS build
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY packages/config/package.json packages/config/
COPY packages/types/package.json packages/types/
COPY apps/api/package.json apps/api/
# The postinstall `prisma generate` needs the schema.
COPY apps/api/prisma/schema.prisma apps/api/prisma/
COPY apps/api/prisma.config.ts apps/api/
# `build_ca` (optional build secret): an extra CA for networks with a TLS-intercepting proxy.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm install --frozen-lockfile --filter @forge/api...
COPY packages/config packages/config
COPY packages/types packages/types
COPY apps/api apps/api
RUN pnpm --filter @forge/types build && pnpm --filter @forge/api build
# A self-contained copy of the API with production dependencies only.
RUN --mount=type=cache,id=pnpm-store,target=/pnpm/store \
    --mount=type=secret,id=build_ca,required=false \
    if [ -s /run/secrets/build_ca ]; then export NODE_EXTRA_CA_CERTS=/run/secrets/build_ca; fi; \
    pnpm --filter @forge/api deploy --prod --legacy /out
# Prisma's CLI tooling arrives as auto-installed peers of @prisma/client; nothing at run time
# imports it (migrations run in the `migrate` image). Dropping it saves about 200 MB.
RUN cd /out/node_modules/.pnpm \
 && rm -rf prisma@* @prisma+studio-core@* @prisma+dev@* @prisma+engines@* @prisma+config@* \
      @electric-sql+pglite@* effect@* \
 && find /out/node_modules -xtype l -delete

# ---- Migrations and seed (one-shot job): needs the Prisma CLI and tsx ----
FROM build AS migrate
# The seed reuses the retrieval eval's documents (FR-8.6).
COPY apps/ai-service/evals/corpus.jsonl apps/ai-service/evals/corpus.jsonl
WORKDIR /repo/apps/api
# The binaries directly, not through pnpm: nothing is downloaded at run time.
ENV PATH=/repo/apps/api/node_modules/.bin:$PATH
USER node
CMD ["prisma", "migrate", "deploy"]

# ---- Runtime ----
FROM node:22-bookworm-slim AS runtime
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build --chown=node:node /out/node_modules ./node_modules
COPY --from=build --chown=node:node /out/package.json ./package.json
COPY --from=build --chown=node:node /repo/apps/api/dist ./dist
USER node
EXPOSE 4000
# The worker uses the same image: `node dist/worker.js`.
CMD ["node", "dist/main.js"]
HEALTHCHECK --interval=10s --timeout=3s --start-period=20s --retries=5 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.API_PORT||4000)+'/api/v1/health/live').then(r=>process.exit(r.ok?0:1),()=>process.exit(1))"]
