-- Add package management engine fields to provider_packages
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "publish_status" TEXT DEFAULT 'DRAFT';
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "configuration_status" TEXT DEFAULT 'UNCONFIGURED';
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "selling_price" DECIMAL(65,30);
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "selling_currency" TEXT DEFAULT 'USD';
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "markup_percent" DECIMAL(65,30);
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "pricing_mode" TEXT DEFAULT 'MARKUP_PERCENT';
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "auto_configured_by_rule_id" TEXT;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "last_configured_at" TIMESTAMP(3);
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "tags" JSONB;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "notes" TEXT;

-- Create indexes on new columns
CREATE INDEX IF NOT EXISTS "provider_packages_publish_status_idx" ON "provider_packages"("publish_status");
CREATE INDEX IF NOT EXISTS "provider_packages_configuration_status_idx" ON "provider_packages"("configuration_status");

-- Create PackageConfigurationRule table
CREATE TABLE IF NOT EXISTS "package_configuration_rules" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider_id" TEXT,
    "country" TEXT,
    "region" TEXT,
    "product_type" TEXT,
    "data_min_gb" INTEGER,
    "data_max_gb" INTEGER,
    "validity_min_days" INTEGER,
    "validity_max_days" INTEGER,
    "markup_percent" DECIMAL(65,30),
    "fixed_price" DECIMAL(65,30),
    "selling_currency" TEXT NOT NULL DEFAULT 'USD',
    "publish_status" TEXT DEFAULT 'READY',
    "priority" INTEGER NOT NULL DEFAULT 0,
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "package_configuration_rules_pkey" PRIMARY KEY ("id")
);

-- Create indexes for PackageConfigurationRule
CREATE INDEX IF NOT EXISTS "package_configuration_rules_provider_id_idx" ON "package_configuration_rules"("provider_id");
CREATE INDEX IF NOT EXISTS "package_configuration_rules_priority_idx" ON "package_configuration_rules"("priority");
CREATE INDEX IF NOT EXISTS "package_configuration_rules_is_active_idx" ON "package_configuration_rules"("is_active");

-- Add FK for autoConfiguredByRuleId
DO $$ BEGIN
    ALTER TABLE "provider_packages" ADD CONSTRAINT "provider_packages_auto_configured_by_rule_id_fkey" FOREIGN KEY ("auto_configured_by_rule_id") REFERENCES "package_configuration_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;
