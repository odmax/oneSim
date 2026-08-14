-- Top-up reconciliation: additive tracking metadata for ESIMTopUp.PENDING_REVIEW.
-- The wallet reservation is UNTOUCHED by this migration — reconciliation resolves
-- it later (capture on confirmed success / release on confirmed failure), always
-- idempotently. No provider mutation is ever re-dispatched from reconciliation.

-- 1. Reconciliation bookkeeping fields (safe defaults for legacy rows).
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "reconciliationAttempts" INTEGER NOT NULL DEFAULT 0;
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "nextReconcileAt" TIMESTAMP(3);
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "lastReconcileAt" TIMESTAMP(3);
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "lastReconcileErrorCode" TEXT;
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "reconcileLockedAt" TIMESTAMP(3);
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "reconcileLockOwner" TEXT;
ALTER TABLE "esim_top_ups" ADD COLUMN IF NOT EXISTS "reconciliationEscalatedAt" TIMESTAMP(3);

-- 2. Recurring background job type for the reconciliation worker.
DO $$ BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_enum
    WHERE enumlabel = 'TOPUP_RECONCILIATION'
      AND enumtypid = '"JobType"'::regtype
  ) THEN
    ALTER TYPE "JobType" ADD VALUE 'TOPUP_RECONCILIATION';
  END IF;
END $$;
