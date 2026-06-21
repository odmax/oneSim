-- Clean up existing duplicates while preserving linked catalog products.
-- Strategy: for each (providerId, providerPlanId) group:
--   1. Prefer keeping the record that has a linked ESIMPackage via providerPackageId
--      (only if providerPackageId column exists on esim_packages)
--   2. Otherwise keep the oldest record
--   3. Delete the rest

-- Use a DO block with information_schema check because providerPackageId may not
-- exist on fresh DB (the column was never created in any migration)
DO $$
DECLARE
  has_provider_package_id bool;
BEGIN
  SELECT EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'esim_packages' AND column_name = 'providerPackageId'
  ) INTO has_provider_package_id;

  IF has_provider_package_id THEN
    DELETE FROM provider_packages pp
    USING (
      WITH grouped AS (
        SELECT pp.id, pp."providerId", pp."providerPlanId", pp."createdAt",
          EXISTS (SELECT 1 FROM esim_packages ep WHERE ep."providerPackageId" = pp.id) AS has_esim
        FROM provider_packages pp
        WHERE pp."providerPlanId" IS NOT NULL AND pp."providerPlanId" != ''
      ),
      ranked AS (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY "providerId", "providerPlanId"
            ORDER BY has_esim DESC, "createdAt" ASC
          ) AS rn
        FROM grouped
      )
      SELECT id FROM ranked WHERE rn > 1
    ) del
    WHERE pp.id = del.id;
  ELSE
    -- Fallback: providerPackageId column does not exist — deduplicate by createdAt only
    DELETE FROM provider_packages pp
    USING (
      SELECT id FROM (
        SELECT id,
          ROW_NUMBER() OVER (
            PARTITION BY "providerId", "providerPlanId"
            ORDER BY "createdAt" ASC
          ) AS rn
        FROM provider_packages
        WHERE "providerPlanId" IS NOT NULL AND "providerPlanId" != ''
      ) d WHERE d.rn > 1
    ) del
    WHERE pp.id = del.id;
  END IF;
END $$;

-- Add the unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_packages_providerId_providerPlanId_key"
  ON "provider_packages" ("providerId", "providerPlanId");
