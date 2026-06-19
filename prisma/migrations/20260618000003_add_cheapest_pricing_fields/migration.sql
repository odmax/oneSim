ALTER TABLE "provider_packages"
  ADD COLUMN IF NOT EXISTS "adminCostPrice" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "effectiveCostPrice" DECIMAL(10,2),
  ADD COLUMN IF NOT EXISTS "costSource" TEXT,
  ADD COLUMN IF NOT EXISTS "comparableKey" TEXT,
  ADD COLUMN IF NOT EXISTS "normalizedCountry" TEXT,
  ADD COLUMN IF NOT EXISTS "normalizedDataLabel" TEXT,
  ADD COLUMN IF NOT EXISTS "normalizedValidityDays" INTEGER,
  ADD COLUMN IF NOT EXISTS "normalizedCoverageType" TEXT,
  ADD COLUMN IF NOT EXISTS "cheapestRank" INTEGER,
  ADD COLUMN IF NOT EXISTS "isCheapestCandidate" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "cheapestReason" TEXT,
  ADD COLUMN IF NOT EXISTS "excludedFromCheapest" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "exclusionReason" TEXT;
