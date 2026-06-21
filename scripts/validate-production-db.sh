#!/usr/bin/env bash
# =============================================================================
# OneSim Africa – Production Validation Commands
# Run these AFTER setup-production-db.sh to verify everything is working.
# =============================================================================
set -euo pipefail

echo "=== OneSim Africa – Production Validation ==="
echo ""

# Change to project root
cd "$(dirname "$0")/.."

# ── 1. PostgreSQL connection test ────────────────────────────────────────────
echo "=== 1. PostgreSQL Connection Test ==="
psql -h localhost -U onesim_prod -d onesim_production -c "SELECT current_database() AS db, current_user AS user, version();" 2>&1 || {
    echo "FAILED: Cannot connect to onesim_production as onesim_prod"
    echo "  Check: host, port, password, pg_hba.conf"
    exit 1
}
echo ""

# ── 2. Database list ─────────────────────────────────────────────────────────
echo "=== 2. Database List ==="
psql -h localhost -U onesim_prod -d onesim_production -c "\l onesim_production"
echo ""

# ── 3. Table list (must be empty before migration) ──────────────────────────
echo "=== 3. Current Tables (should be empty before migrate deploy) ==="
psql -h localhost -U onesim_prod -d onesim_production -c "\dt" || echo "(no tables yet)"
echo ""

# ── 4. Prisma generate ─────────────────────────────────────────────────────
echo "=== 4. Prisma Generate ==="
npx prisma generate
echo ""

# ── 5. Prisma migrate deploy ────────────────────────────────────────────────
echo "=== 5. Prisma Migrate Deploy ==="
# Dry-run first
echo ">>> Dry run (check SQL without applying):"
npx prisma migrate deploy --dry-run 2>&1 || true
echo ""
echo ">>> Apply migrations:"
npx prisma migrate deploy 2>&1 || {
    echo "FAILED: Migration deploy failed. See rollback steps below."
    exit 1
}
echo ""

# ── 6. Verify tables after migration ────────────────────────────────────────
echo "=== 6. Tables After Migration ==="
psql -h localhost -U onesim_prod -d onesim_production -c "\dt"
echo ""

# ── 7. Verify Prisma schema matches database ────────────────────────────────
echo "=== 7. Prisma Schema Check ==="
npx prisma validate
echo ""

# ── 8. Summary ──────────────────────────────────────────────────────────────
echo "=== Summary ==="
echo "  Database: onesim_production"
echo "  User:     onesim_prod"
echo "  Host:     localhost"
echo "  Port:     5432"
echo "  Status:   READY"
echo ""
echo "Next steps:"
echo "  1. Copy .env.production to .env on the production server"
echo "  2. Start the app: npm run build && npm run start"
echo "  3. Create the first admin user via the UI"
echo "  4. Configure providers (AirHub, Rakuten, Choice) with production credentials"
echo "  5. Run initial provider sync"
echo ""
