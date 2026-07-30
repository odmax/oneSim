-- Phase 5C: Provider Wallet & Wallet Snapshots
-- All statements are idempotent — safe to run regardless of existing state.

CREATE TABLE IF NOT EXISTS "provider_wallets" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "available" TEXT,
    "lastSyncedAt" TIMESTAMP(3),
    "syncStatus" TEXT DEFAULT 'OK',
    "lastError" TEXT,
    "lowBalanceThreshold" DOUBLE PRECISION DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "provider_wallets_pkey" PRIMARY KEY ("id")
);

-- Drop and recreate unique index to clean up any prior db push artifacts
DROP INDEX IF EXISTS "provider_wallets_providerId_key";
CREATE UNIQUE INDEX "provider_wallets_providerId_key" ON "provider_wallets"("providerId");
CREATE INDEX IF NOT EXISTS "provider_wallets_providerId_idx" ON "provider_wallets"("providerId");

CREATE TABLE IF NOT EXISTS "provider_wallet_snapshots" (
    "id" TEXT NOT NULL,
    "walletId" TEXT NOT NULL,
    "balance" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "available" TEXT,
    "snapshotAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "provider_wallet_snapshots_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "provider_wallet_snapshots_walletId_snapshotAt_idx" ON "provider_wallet_snapshots"("walletId", "snapshotAt");

-- Handle FK that may already exist from db push
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.table_constraints
        WHERE constraint_name = 'provider_wallet_snapshots_walletId_fkey'
    ) THEN
        ALTER TABLE "provider_wallet_snapshots"
        ADD CONSTRAINT "provider_wallet_snapshots_walletId_fkey"
        FOREIGN KEY ("walletId") REFERENCES "provider_wallets"("id")
        ON DELETE CASCADE ON UPDATE CASCADE;
    END IF;
END $$;
