-- ProviderBundleDefinition — Admin-created SKU/bundle definitions
CREATE TABLE IF NOT EXISTS "provider_bundle_definitions" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "providerId" TEXT NOT NULL,
    "externalSku" TEXT,
    "bundleCode" TEXT,
    "bundleName" TEXT NOT NULL,
    "dataAllowance" INTEGER,
    "dataUnit" TEXT DEFAULT 'MB',
    "validityDays" INTEGER,
    "occurrences" INTEGER DEFAULT 1,
    "tethering" BOOLEAN DEFAULT false,
    "throttling" BOOLEAN DEFAULT false,
    "throttleThresholdPercent" INTEGER,
    "throttleSpeedKbps" INTEGER,
    "roamingProfileId" TEXT,
    "pool" TEXT,
    "servingNetworks" TEXT,
    "smsAllowance" INTEGER,
    "voiceMinutes" INTEGER,
    "providerMetadata" JSONB,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "externalVersion" TEXT,
    "createdBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_bundle_definitions_pkey" PRIMARY KEY ("id")
);
CREATE INDEX IF NOT EXISTS "provider_bundle_definitions_providerId_idx" ON "provider_bundle_definitions"("providerId");
CREATE INDEX IF NOT EXISTS "provider_bundle_definitions_status_idx" ON "provider_bundle_definitions"("status");
