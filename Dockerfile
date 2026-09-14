# syntax=docker/dockerfile:1

# ============================================================================
# OneSIM — ECS/Fargate container image (first migration)
#
# Multi-stage Debian-slim build:
#   deps    -> deterministic dependency install (npm ci, full tree for build)
#   builder -> prisma generate + production `next build`
#   runner  -> production-only deps (Prisma CLI is a production dependency so
#              the SAME image can run the one-off ECS migration task via
#              `npm run db:migrate:deploy`)
#
# Runtime: non-root `node` user, port 3000, exec-form CMD so Node/Next is PID 1
# and receives SIGTERM directly. Migrations are NEVER executed at startup and
# no database is seeded. No secrets are baked in and no .env files are copied.
#
# Build-time notes:
#   - NEXTAUTH_SECRET is required at BUILDer time only (auth/config.ts validates
#     it at module load and throws in production). It is a build-only
#     placeholder; the runner stage does not inherit it.
#   - No DATABASE_URL is required at build time (verified: DB-backed pages bail
#     to dynamic rendering; `next build` performs zero DB network access).
# ============================================================================

FROM node:22-trixie-slim@sha256:a05717adfe7289e2a0fa36a694dc430a510adab6467c7036e51551198935abef AS deps
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

FROM node:22-trixie-slim@sha256:a05717adfe7289e2a0fa36a694dc430a510adab6467c7036e51551198935abef AS builder
WORKDIR /app
# NEXTAUTH_SECRET: auth/config.ts validates this var at MODULE LOAD and throws
# in production, so a build-time value must exist. It is a LOCAL BUILD-ONLY
# placeholder — it is never shipped (runtime ECS tasks supply the real secret
# via their own environment) and the runner stage does NOT inherit it.
# JOB_WORKER_ENABLED=false keeps the in-process worker from attempting DB work
# while `next build` bootstraps the server for route collection.
ARG NEXTAUTH_SECRET=build-time-only-placeholder-secret-change-me
ENV NEXT_TELEMETRY_DISABLED=1 \
    NODE_ENV=production \
    JOB_WORKER_ENABLED=false \
    NEXTAUTH_SECRET=$NEXTAUTH_SECRET
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Generate the Prisma client from the schema (no database required).
RUN npx prisma generate
# Canonical production build (next build).
RUN npm run build

FROM node:22-trixie-slim@sha256:a05717adfe7289e2a0fa36a694dc430a510adab6467c7036e51551198935abef AS runner
WORKDIR /app
ENV NODE_ENV=production \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    NEXT_TELEMETRY_DISABLED=1
RUN apt-get update \
  && apt-get install -y --no-install-recommends openssl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 1001 onesim \
  && useradd --system --uid 1001 --gid onesim --home /app --no-create-home onesim

# Production-only dependency tree. `prisma` is a production dependency so the
# same image can run `npm run db:migrate:deploy` as an ECS one-off task.
COPY package.json package-lock.json ./
RUN PRISMA_SKIP_POSTINSTALL_GENERATE=true npm ci --omit=dev --no-audit --no-fund

# Generated Prisma client + engine binaries copied from the build stage so the
# runtime client and engine are byte-for-byte the ones used to build .next.
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma
COPY --from=builder /app/node_modules/@prisma ./node_modules/@prisma

# Build output + runtime-only files. No source, no .env, no git, no logs,
# no SQL backups, no diagnostics.
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/next.config.js ./next.config.js

RUN chown -R onesim:onesim /app && chmod -R u=rwX,go=rX /app

USER onesim
EXPOSE 3000

# Dependency-free Docker health probe. /api/health is provider-free (SELECT 1).
# ECS/Fargate will additionally use task-definition ALB target checks.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD ["node", "-e", "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]

# Explicitly clear the base-image ENTRYPOINT. Official `node:<version>:*.slim`
# images ship `ENTRYPOINT ["docker-entrypoint.sh"]` (a thin `exec "$@"` shim,
# see https://github.com/nodejs/docker-node/blob/main/docker-entrypoint.sh).
# Inheriting it would make the effective runtime command depend on base-image
# internals (command -v / dash workaround logic). For the ECS/Fargate contract we
# want a deterministic final image: PID 1 is exactly the Next.js server.
ENTRYPOINT []

# Deterministic exec-form start. Running the real Next CLI entry
# (`node <dist>/bin/next` is what `npm start` -> `next start` resolves to) through
# `node` directly makes Node the PID 1 process with no npm / bourne wrapper, no
# PM2, no shell bootstrap and no shebang/env indirection, so ECS/Fargate SIGTERM
# is delivered straight to the Next server.
CMD ["node", "./node_modules/next/dist/bin/next", "start"]