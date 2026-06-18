-- Clean up existing duplicates while preserving linked catalog products.
-- Strategy: for each (providerId, providerPlanId) group:
--   1. Prefer keeping the record that has a linked ESIMPackage via providerPackageId
--   2. Otherwise keep the oldest record
--   3. Delete the rest

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

-- Add the unique constraint
CREATE UNIQUE INDEX IF NOT EXISTS "provider_packages_providerId_providerPlanId_key"
  ON "provider_packages" ("providerId", "providerPlanId");
