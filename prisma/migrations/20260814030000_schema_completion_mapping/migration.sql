-- Schema completion — MAPPING: physical column names + FK/index normalization.
--
-- The original hand-written migrations created several tables with snake_case
-- physical column names that contradict prisma/schema.prisma (which has no @map
-- on these fields, so Prisma reads camelCase columns). The existing production
-- schema was built by db-push drift and already uses camelCase, so every rename
-- below is a guarded no-op there. On a fresh replay it renames the snake_case
-- columns to the canonical camelCase names, preserving data.
--
-- Additive/guarded throughout. No applied migration is modified (checksums
-- preserved). No DROP COLUMN / DROP TABLE — only RENAME COLUMN, ADD COLUMN,
-- constraint normalization (FK/index names), and safe type/required fixes.

-- ══════════════════════════════════════════════════════════════════════════
-- billing_records  (CRITICAL_RUNTIME — billing/top-up/P&L)
-- ══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='business_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='businessId') THEN ALTER TABLE "billing_records" RENAME COLUMN "business_id" TO "businessId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='created_at') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='createdAt') THEN ALTER TABLE "billing_records" RENAME COLUMN "created_at" TO "createdAt"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='esim_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='esimId') THEN ALTER TABLE "billing_records" RENAME COLUMN "esim_id" TO "esimId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='invoice_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='invoiceId') THEN ALTER TABLE "billing_records" RENAME COLUMN "invoice_id" TO "invoiceId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='margin_amount') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='marginAmount') THEN ALTER TABLE "billing_records" RENAME COLUMN "margin_amount" TO "marginAmount"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='margin_percent') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='marginPercent') THEN ALTER TABLE "billing_records" RENAME COLUMN "margin_percent" TO "marginPercent"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='order_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='orderId') THEN ALTER TABLE "billing_records" RENAME COLUMN "order_id" TO "orderId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='provider_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='providerId') THEN ALTER TABLE "billing_records" RENAME COLUMN "provider_id" TO "providerId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='sales_agent_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='billing_records' AND column_name='salesAgentId') THEN ALTER TABLE "billing_records" RENAME COLUMN "sales_agent_id" TO "salesAgentId"; END IF; END $$;

DO $$ BEGIN ALTER TABLE "billing_records" DROP CONSTRAINT IF EXISTS "billing_records_business_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" DROP CONSTRAINT IF EXISTS "billing_records_esim_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" DROP CONSTRAINT IF EXISTS "billing_records_invoice_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" DROP CONSTRAINT IF EXISTS "billing_records_order_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" DROP CONSTRAINT IF EXISTS "billing_records_provider_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" DROP CONSTRAINT IF EXISTS "billing_records_sales_agent_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "esim_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_esimId_fkey" FOREIGN KEY ("esimId") REFERENCES "esims"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "billing_records" ADD CONSTRAINT "billing_records_salesAgentId_fkey" FOREIGN KEY ("salesAgentId") REFERENCES "internal_admins"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='billing_records_business_id_created_at_idx') THEN ALTER INDEX "billing_records_business_id_created_at_idx" RENAME TO "billing_records_businessId_createdAt_idx"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='billing_records_provider_id_created_at_idx') THEN ALTER INDEX "billing_records_provider_id_created_at_idx" RENAME TO "billing_records_providerId_createdAt_idx"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='billing_records_sales_agent_id_created_at_idx') THEN ALTER INDEX "billing_records_sales_agent_id_created_at_idx" RENAME TO "billing_records_salesAgentId_createdAt_idx"; END IF; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- invoice_line_items
-- ══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='invoice_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='invoiceId') THEN ALTER TABLE "invoice_line_items" RENAME COLUMN "invoice_id" TO "invoiceId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='created_at') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='createdAt') THEN ALTER TABLE "invoice_line_items" RENAME COLUMN "created_at" TO "createdAt"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='tax_amount') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='taxAmount') THEN ALTER TABLE "invoice_line_items" RENAME COLUMN "tax_amount" TO "taxAmount"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='tax_rate') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='taxRate') THEN ALTER TABLE "invoice_line_items" RENAME COLUMN "tax_rate" TO "taxRate"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='total_price') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='totalPrice') THEN ALTER TABLE "invoice_line_items" RENAME COLUMN "total_price" TO "totalPrice"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='unit_price') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='invoice_line_items' AND column_name='unitPrice') THEN ALTER TABLE "invoice_line_items" RENAME COLUMN "unit_price" TO "unitPrice"; END IF; END $$;
DO $$ BEGIN ALTER TABLE "invoice_line_items" DROP CONSTRAINT IF EXISTS "invoice_line_items_invoice_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoiceId_fkey" FOREIGN KEY ("invoiceId") REFERENCES "invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DROP INDEX IF EXISTS "invoice_line_items_invoice_id_idx";

-- ══════════════════════════════════════════════════════════════════════════
-- catalog_change_sets / catalog_change_items
-- ══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_sets' AND column_name='action_type') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_sets' AND column_name='actionType') THEN ALTER TABLE "catalog_change_sets" RENAME COLUMN "action_type" TO "actionType"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_sets' AND column_name='created_at') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_sets' AND column_name='createdAt') THEN ALTER TABLE "catalog_change_sets" RENAME COLUMN "created_at" TO "createdAt"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_sets' AND column_name='created_by_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_sets' AND column_name='createdById') THEN ALTER TABLE "catalog_change_sets" RENAME COLUMN "created_by_id" TO "createdById"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_sets' AND column_name='total_changed') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_sets' AND column_name='totalChanged') THEN ALTER TABLE "catalog_change_sets" RENAME COLUMN "total_changed" TO "totalChanged"; END IF; END $$;
DO $$ BEGIN ALTER TABLE "catalog_change_sets" DROP CONSTRAINT IF EXISTS "catalog_change_sets_created_by_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "catalog_change_sets" ADD CONSTRAINT "catalog_change_sets_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_items' AND column_name='change_set_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_items' AND column_name='changeSetId') THEN ALTER TABLE "catalog_change_items" RENAME COLUMN "change_set_id" TO "changeSetId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_items' AND column_name='created_at') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_items' AND column_name='createdAt') THEN ALTER TABLE "catalog_change_items" RENAME COLUMN "created_at" TO "createdAt"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_items' AND column_name='provider_package_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='catalog_change_items' AND column_name='providerPackageId') THEN ALTER TABLE "catalog_change_items" RENAME COLUMN "provider_package_id" TO "providerPackageId"; END IF; END $$;
DO $$ BEGIN ALTER TABLE "catalog_change_items" DROP CONSTRAINT IF EXISTS "catalog_change_items_change_set_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "catalog_change_items" DROP CONSTRAINT IF EXISTS "catalog_change_items_provider_package_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "catalog_change_items" ADD CONSTRAINT "catalog_change_items_changeSetId_fkey" FOREIGN KEY ("changeSetId") REFERENCES "catalog_change_sets"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "catalog_change_items" ADD CONSTRAINT "catalog_change_items_providerPackageId_fkey" FOREIGN KEY ("providerPackageId") REFERENCES "provider_packages"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- package_configuration_rules
-- ══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='created_at') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='createdAt') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "created_at" TO "createdAt"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='updated_at') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='updatedAt') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "updated_at" TO "updatedAt"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='data_min_gb') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='dataMinGB') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "data_min_gb" TO "dataMinGB"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='data_max_gb') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='dataMaxGB') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "data_max_gb" TO "dataMaxGB"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='validity_min_days') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='validityMinDays') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "validity_min_days" TO "validityMinDays"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='validity_max_days') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='validityMaxDays') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "validity_max_days" TO "validityMaxDays"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='markup_percent') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='markupPercent') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "markup_percent" TO "markupPercent"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='fixed_price') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='fixedPrice') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "fixed_price" TO "fixedPrice"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='selling_currency') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='sellingCurrency') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "selling_currency" TO "sellingCurrency"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='publish_status') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='publishStatus') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "publish_status" TO "publishStatus"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='product_type') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='productType') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "product_type" TO "productType"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='provider_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='providerId') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "provider_id" TO "providerId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='is_active') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='package_configuration_rules' AND column_name='isActive') THEN ALTER TABLE "package_configuration_rules" RENAME COLUMN "is_active" TO "isActive"; END IF; END $$;
ALTER TABLE "package_configuration_rules" ADD COLUMN IF NOT EXISTS "costPrice" DECIMAL(65,30);
ALTER TABLE "package_configuration_rules" ALTER COLUMN "updatedAt" DROP DEFAULT;
DO $$ BEGIN ALTER TABLE "package_configuration_rules" DROP CONSTRAINT IF EXISTS "package_configuration_rules_provider_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "package_configuration_rules" ADD CONSTRAINT "package_configuration_rules_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DROP INDEX IF EXISTS "package_configuration_rules_is_active_idx";
DROP INDEX IF EXISTS "package_configuration_rules_provider_id_idx";
CREATE INDEX IF NOT EXISTS "package_configuration_rules_providerId_idx" ON "package_configuration_rules"("providerId");
CREATE INDEX IF NOT EXISTS "package_configuration_rules_isActive_idx" ON "package_configuration_rules"("isActive");

-- ══════════════════════════════════════════════════════════════════════════
-- provider_packages
-- ══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='auto_configured_by_rule_id') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='autoConfiguredByRuleId') THEN ALTER TABLE "provider_packages" RENAME COLUMN "auto_configured_by_rule_id" TO "autoConfiguredByRuleId"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='auto_pick_reason') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='autoPickReason') THEN ALTER TABLE "provider_packages" RENAME COLUMN "auto_pick_reason" TO "autoPickReason"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='configuration_status') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='configurationStatus') THEN ALTER TABLE "provider_packages" RENAME COLUMN "configuration_status" TO "configurationStatus"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='excluded_from_auto_pick') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='excludedFromAutoPick') THEN ALTER TABLE "provider_packages" RENAME COLUMN "excluded_from_auto_pick" TO "excludedFromAutoPick"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='is_preferred') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='isPreferred') THEN ALTER TABLE "provider_packages" RENAME COLUMN "is_preferred" TO "isPreferred"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='last_configured_at') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='lastConfiguredAt') THEN ALTER TABLE "provider_packages" RENAME COLUMN "last_configured_at" TO "lastConfiguredAt"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='markup_percent') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='markupPercent') THEN ALTER TABLE "provider_packages" RENAME COLUMN "markup_percent" TO "markupPercent"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='preferred_at') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='preferredAt') THEN ALTER TABLE "provider_packages" RENAME COLUMN "preferred_at" TO "preferredAt"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='preferred_reason') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='preferredReason') THEN ALTER TABLE "provider_packages" RENAME COLUMN "preferred_reason" TO "preferredReason"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='pricing_mode') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='pricingMode') THEN ALTER TABLE "provider_packages" RENAME COLUMN "pricing_mode" TO "pricingMode"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='publish_status') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='publishStatus') THEN ALTER TABLE "provider_packages" RENAME COLUMN "publish_status" TO "publishStatus"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='selling_currency') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='sellingCurrency') THEN ALTER TABLE "provider_packages" RENAME COLUMN "selling_currency" TO "sellingCurrency"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='selling_price') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='provider_packages' AND column_name='sellingPrice') THEN ALTER TABLE "provider_packages" RENAME COLUMN "selling_price" TO "sellingPrice"; END IF; END $$;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "providerStatus" TEXT;
ALTER TABLE "provider_packages" ADD COLUMN IF NOT EXISTS "providerTemplateId" TEXT;
ALTER TABLE "provider_packages" ALTER COLUMN "taxAmount" SET DATA TYPE DECIMAL(65,30);
UPDATE "provider_packages" SET "isTaxInclusive" = false WHERE "isTaxInclusive" IS NULL;
UPDATE "provider_packages" SET "travelDateLeadDays" = 0 WHERE "travelDateLeadDays" IS NULL;
ALTER TABLE "provider_packages" ALTER COLUMN "isTaxInclusive" SET NOT NULL;
ALTER TABLE "provider_packages" ALTER COLUMN "travelDateLeadDays" SET NOT NULL;
DO $$ BEGIN ALTER TABLE "provider_packages" DROP CONSTRAINT IF EXISTS "provider_packages_auto_configured_by_rule_id_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "provider_packages" ADD CONSTRAINT "provider_packages_autoConfiguredByRuleId_fkey" FOREIGN KEY ("autoConfiguredByRuleId") REFERENCES "package_configuration_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "provider_packages" ADD CONSTRAINT "provider_packages_activePriceSnapshotId_fkey" FOREIGN KEY ("activePriceSnapshotId") REFERENCES "package_price_snapshots"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DROP INDEX IF EXISTS "provider_packages_configuration_status_idx";
DROP INDEX IF EXISTS "provider_packages_publish_status_idx";
CREATE INDEX IF NOT EXISTS "provider_packages_publishStatus_idx" ON "provider_packages"("publishStatus");
CREATE INDEX IF NOT EXISTS "provider_packages_configurationStatus_idx" ON "provider_packages"("configurationStatus");

-- ══════════════════════════════════════════════════════════════════════════
-- providers
-- ══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='auto_publish_enabled') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='autoPublishEnabled') THEN ALTER TABLE "providers" RENAME COLUMN "auto_publish_enabled" TO "autoPublishEnabled"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='catalog_priority') AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='providers' AND column_name='catalogPriority') THEN ALTER TABLE "providers" RENAME COLUMN "catalog_priority" TO "catalogPriority"; END IF; END $$;
-- NOTE: providers.selfHealLeaseUntil is intentionally KEPT (legacy column not in
-- schema.prisma; used by provider self-heal raw SQL). Not dropped.
DO $$ BEGIN ALTER TABLE "providers" ADD CONSTRAINT "providers_providerTemplateId_fkey" FOREIGN KEY ("providerTemplateId") REFERENCES "provider_templates"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ══════════════════════════════════════════════════════════════════════════
-- FK name/action normalization on existing tables (Prisma expects ON UPDATE
-- CASCADE and Prisma-standard constraint names)
-- ══════════════════════════════════════════════════════════════════════════
DO $$ BEGIN ALTER TABLE "order_timeline_events" DROP CONSTRAINT IF EXISTS "order_timeline_events_orderId_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "order_timeline_events" ADD CONSTRAINT "order_timeline_events_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "esim_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "order_timeline_events" ADD CONSTRAINT "order_timeline_events_createdById_fkey" FOREIGN KEY ("createdById") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "provider_audits" DROP CONSTRAINT IF EXISTS "provider_audits_providerId_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "provider_audits" ADD CONSTRAINT "provider_audits_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "provider_audit_checks" DROP CONSTRAINT IF EXISTS "provider_audit_checks_auditId_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "provider_audit_checks" ADD CONSTRAINT "provider_audit_checks_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "provider_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "provider_audit_notes" DROP CONSTRAINT IF EXISTS "provider_audit_notes_auditId_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "provider_audit_notes" ADD CONSTRAINT "provider_audit_notes_auditId_fkey" FOREIGN KEY ("auditId") REFERENCES "provider_audits"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "provider_audit_notes" DROP CONSTRAINT IF EXISTS "provider_audit_notes_authorId_fkey"; END $$;
DO $$ BEGIN ALTER TABLE "provider_audit_notes" ADD CONSTRAINT "provider_audit_notes_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN ALTER TABLE "order_callback_deliveries" DROP CONSTRAINT IF EXISTS "fk_callback_business"; END $$;
DO $$ BEGIN ALTER TABLE "order_callback_deliveries" DROP CONSTRAINT IF EXISTS "fk_callback_order"; END $$;
DO $$ BEGIN ALTER TABLE "order_callback_deliveries" ADD CONSTRAINT "order_callback_deliveries_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "esim_purchases"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "order_callback_deliveries" ADD CONSTRAINT "order_callback_deliveries_businessId_fkey" FOREIGN KEY ("businessId") REFERENCES "businesses"("id") ON DELETE CASCADE ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_callback_business') THEN ALTER INDEX "idx_callback_business" RENAME TO "order_callback_deliveries_businessId_idx"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_callback_next_attempt') THEN ALTER INDEX "idx_callback_next_attempt" RENAME TO "order_callback_deliveries_nextAttemptAt_idx"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_callback_order') THEN ALTER INDEX "idx_callback_order" RENAME TO "order_callback_deliveries_orderId_idx"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_callback_status') THEN ALTER INDEX "idx_callback_status" RENAME TO "order_callback_deliveries_status_idx"; END IF; END $$;

DO $$ BEGIN ALTER TABLE "provider_inventory_reservations" DROP CONSTRAINT IF EXISTS "fk_inventory_reservation_provider"; END $$;
DO $$ BEGIN ALTER TABLE "provider_inventory_reservations" DROP CONSTRAINT IF EXISTS "fk_inventory_reservation_order"; END $$;
DO $$ BEGIN ALTER TABLE "provider_inventory_reservations" ADD CONSTRAINT "provider_inventory_reservations_providerId_fkey" FOREIGN KEY ("providerId") REFERENCES "providers"("id") ON DELETE RESTRICT ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN ALTER TABLE "provider_inventory_reservations" ADD CONSTRAINT "provider_inventory_reservations_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "esim_purchases"("id") ON DELETE SET NULL ON UPDATE CASCADE; EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_provider_inventory_reservations_expiresAt') THEN ALTER INDEX "idx_provider_inventory_reservations_expiresAt" RENAME TO "provider_inventory_reservations_expiresAt_idx"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_provider_inventory_reservations_orderId') THEN ALTER INDEX "idx_provider_inventory_reservations_orderId" RENAME TO "provider_inventory_reservations_orderId_idx"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_provider_inventory_reservations_providerId') THEN ALTER INDEX "idx_provider_inventory_reservations_providerId" RENAME TO "provider_inventory_reservations_providerId_idx"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_provider_inventory_reservations_reservationKey') THEN ALTER INDEX "idx_provider_inventory_reservations_reservationKey" RENAME TO "provider_inventory_reservations_reservationKey_idx"; END IF; END $$;
DO $$ BEGIN IF EXISTS (SELECT 1 FROM pg_indexes WHERE schemaname='public' AND indexname='idx_provider_inventory_reservations_status') THEN ALTER INDEX "idx_provider_inventory_reservations_status" RENAME TO "provider_inventory_reservations_status_idx"; END IF; END $$;

-- ── Other legacy extra indexes (safe drops; Prisma does not model them) ──
DROP INDEX IF EXISTS "idx_audit_logs_created";
DROP INDEX IF EXISTS "customers_businessId_idx";
DROP INDEX IF EXISTS "idx_provider_attempts_order_attempt";
DROP INDEX IF EXISTS "idx_provider_webhook_events_status_received";
CREATE INDEX IF NOT EXISTS "customers_providerSubscriberId_idx" ON "customers"("providerSubscriberId");

-- ── wallet_transactions indexes (Option A billing; already present from the
--    top-up migration — kept idempotent) ──
CREATE INDEX IF NOT EXISTS "wallet_transactions_orderId_type_idx" ON "wallet_transactions"("orderId", "type");
CREATE INDEX IF NOT EXISTS "wallet_transactions_topUpId_type_idx" ON "wallet_transactions"("topUpId", "type");
