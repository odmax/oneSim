-- Provider capability exposure — Client Portal / Client API toggles
CREATE TABLE IF NOT EXISTS "provider_capability_exposure" (
    "id" TEXT NOT NULL DEFAULT gen_random_uuid(),
    "providerId" TEXT NOT NULL,
    "capability" TEXT NOT NULL,
    "clientPortalEnabled" BOOLEAN NOT NULL DEFAULT false,
    "clientApiEnabled" BOOLEAN NOT NULL DEFAULT false,
    "updatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "provider_capability_exposure_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX IF NOT EXISTS "provider_capability_exposure_provider_capability_key" ON "provider_capability_exposure"("providerId","capability");
