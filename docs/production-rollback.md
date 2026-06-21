# =============================================================================
# OneSim Africa – Production Migration Rollback Steps
# =============================================================================
#
# If npx prisma migrate deploy fails, follow these steps:
#
# ── Step 1: Identify the failed migration ────────────────────────────────────
#
#   npx prisma migrate status
#
# This shows which migrations have been applied and which are pending.
# The failing migration will be listed as "not applied".
#
# ── Step 2: Roll back the last applied migration ─────────────────────────────
#
#   # Replace MIGRATION_NAME with the name from prisma/migrations/
#   npx prisma migrate resolve --rolled-back MIGRATION_NAME
#
#   # Example:
#   npx prisma migrate resolve --rolled-back 20260618000004_add_provider_audit
#
# ── Step 3: Manual SQL rollback ─────────────────────────────────────────────
#
# If you need to revert SQL directly:
#
#   psql -h localhost -U onesim_prod -d onesim_production
#
#   -- Drop all tables (complete rollback):
#   DROP SCHEMA public CASCADE;
#   CREATE SCHEMA public;
#   GRANT ALL ON SCHEMA public TO onesim_prod;
#   GRANT ALL ON SCHEMA public TO public;
#
#   -- Reset migration tracking:
#   DELETE FROM _prisma_migrations;
#
#   -- Then re-run from scratch:
#   npx prisma migrate deploy
#
# ── Step 4: Partial rollback (single migration) ──────────────────────────────
#
#   psql -h localhost -U onesim_prod -d onesim_production
#
#   -- For example, revert add_provider_audit:
#   DROP TABLE IF EXISTS provider_audit_notes;
#   DROP TABLE IF EXISTS provider_audit_checks;
#   DROP TABLE IF EXISTS provider_audits;
#
#   npx prisma migrate resolve --rolled-back 20260618000004_add_provider_audit
#
# ── Step 5: Verify rollback ──────────────────────────────────────────────────
#
#   npx prisma migrate status
#   # Should show the rolled-back migration as "not applied"
#
# ── Step 6: Fix and retry ────────────────────────────────────────────────────
#
#   1. Fix the issue (schema conflict, missing extension, etc.)
#   2. Re-run: npx prisma migrate deploy
#
# ── Emergency: Full database reset ──────────────────────────────────────────
#
#   WARNING: THIS DESTROYS ALL DATA
#
#   psql -h localhost -U onesim_prod -d onesim_production -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"
#   npx prisma migrate deploy
#
# =============================================================================
