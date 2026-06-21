CREATE TABLE IF NOT EXISTS "provider_packages" (
    "id" TEXT NOT NULL,
    "providerId" TEXT NOT NULL,
    "providerPlanId" TEXT NOT NULL,
    "providerPlanCode" TEXT,
    "name" TEXT NOT NULL,
    "dataGB" INTEGER NOT NULL,
    "validityDays" INTEGER NOT NULL,
    "costPrice" DECIMAL(65,30) NOT NULL,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "country" TEXT,
    "region" TEXT,
    "planType" TEXT,
    "isAvailable" BOOLEAN NOT NULL DEFAULT true,
    "providerRawData" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "provider_packages_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "provider_packages_providerId_idx" ON "provider_packages"("providerId");

DO $$ BEGIN
  ALTER TABLE "provider_packages" ADD CONSTRAINT "provider_packages_providerId_fkey"
    FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL; WHEN undefined_table THEN NULL;
END $$;
