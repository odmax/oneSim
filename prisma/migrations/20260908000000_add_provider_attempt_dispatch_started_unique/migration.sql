-- P0 V2: ProviderAttempt crash-recovery hardening.
--
-- Additive only: create column + create index. No destructive statements, no
-- backfill, no NOT NULL, no historical row rewrite.
-- Matches prisma/schema.prisma for ProviderAttempt:
--   1. Add nullable dispatchStartedAt (dispatched marker committed BEFORE the
--      provider purchase call, so a crash mid-dispatch is recoverable).
--   2. Enforce unique (orderId, attemptNumber) at the DB level — at most one
--      attempt per sequence per order (single-writer guarantee).
--
-- A duplicate preflight scan MUST be run against staging/production BEFORE
-- `prisma migrate deploy`. If duplicates exist, deployment must stop.

-- AlterTable
ALTER TABLE "provider_attempts" ADD COLUMN "dispatchStartedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "provider_attempts_orderId_attemptNumber_key"
ON "provider_attempts"("orderId", "attemptNumber");
