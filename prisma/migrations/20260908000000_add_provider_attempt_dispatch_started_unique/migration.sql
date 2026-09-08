-- P0 V2: ProviderAttempt crash-recovery hardening.
--
-- Additive only: create column + create index. No destructive statements, no
-- backfill, no NOT NULL, no historical row rewrite.
-- Matches prisma/schema.prisma for ProviderAttempt:
--   1. Add nullable dispatchStartedAt (dispatched marker committed BEFORE the
--      provider purchase call, so a crash mid-dispatch is recoverable).
--   2. Enforce unique (orderId, source, attemptNumber). Attempt numbering is
--      scoped PER SOURCE: PURCHASE and RECONCILIATION each keep an independent
--      per-order sequence, so a legitimate PURCHASE#1 and RECONCILIATION#1 may
--      coexist (historical staging data confirms this). Uniqueness within a
--      (source, attemptNumber) pair is the purchase-dispatch ownership guard —
--      two concurrent workers can never both insert the same-number
--      PURCHASE dispatch row for the same order.
--
-- A duplicate preflight scan MUST be run against staging/production BEFORE
-- `prisma migrate deploy`. If duplicates exist under the new key, deployment
-- must stop.

-- AlterTable
ALTER TABLE "provider_attempts" ADD COLUMN "dispatchStartedAt" TIMESTAMP(3);

-- CreateIndex
CREATE UNIQUE INDEX "provider_attempts_orderId_source_attemptNumber_key"
ON "provider_attempts"("orderId", "source", "attemptNumber");
