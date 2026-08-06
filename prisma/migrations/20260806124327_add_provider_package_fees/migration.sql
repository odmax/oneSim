-- Create missing provider_package_fees and provider_cost_snapshots tables
-- These are in the Prisma schema but were never migrated.

-- Provider Package Fees
CREATE TABLE IF NOT EXISTS "provider_package_fees" (
    "id" TEXT NOT NULL,
    "providerPackageId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "amount" DECIMAL(18,6) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "chargeTiming" TEXT NOT NULL,
    "label" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_package_fees_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "provider_package_fees_providerPackageId_idx" ON "provider_package_fees"("providerPackageId");
ALTER TABLE "provider_package_fees" ADD CONSTRAINT "provider_package_fees_providerPackageId_fkey" FOREIGN KEY ("providerPackageId") REFERENCES "provider_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Provider Cost Snapshots
CREATE TABLE IF NOT EXISTS "provider_cost_snapshots" (
    "id" TEXT NOT NULL,
    "providerPackageId" TEXT NOT NULL,
    "originalAmount" DECIMAL(18,6) NOT NULL,
    "originalCurrency" TEXT NOT NULL DEFAULT 'USD',
    "normalizedAmount" DECIMAL(18,6) NOT NULL,
    "normalizedCurrency" TEXT NOT NULL DEFAULT 'USD',
    "costSource" TEXT NOT NULL,
    "exchangeRate" DECIMAL(24,12),
    "exchangeRateSource" TEXT,
    "exchangeRateVersion" TEXT,
    "isTaxInclusive" BOOLEAN NOT NULL DEFAULT false,
    "taxAmount" DECIMAL(18,6),
    "feesSnapshot" JSONB,
    "receivedAt" TIMESTAMP(3) NOT NULL,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "metadata" JSONB,
    CONSTRAINT "provider_cost_snapshots_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "provider_cost_snapshots_providerPackageId_createdAt_idx" ON "provider_cost_snapshots"("providerPackageId","createdAt");
ALTER TABLE "provider_cost_snapshots" ADD CONSTRAINT "provider_cost_snapshots_providerPackageId_fkey" FOREIGN KEY ("providerPackageId") REFERENCES "provider_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE;
