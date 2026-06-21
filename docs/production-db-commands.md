# =============================================================================
# OneSim Africa – Production Database Setup Commands
# Run these as postgres superuser on the production database server.
# =============================================================================

# ── 1. Create database ───────────────────────────────────────────────────────
sudo -u postgres psql -c "CREATE DATABASE onesim_production;"

# ── 2. Create user with secure password ──────────────────────────────────────
# Replace 'YOUR_SECURE_PASSWORD' with the output of: openssl rand -base64 24 | tr -dc 'A-Za-z0-9_-' | head -c 32
sudo -u postgres psql -c "CREATE USER onesim_prod WITH PASSWORD 'YOUR_SECURE_PASSWORD';"

# ── 3. Grant privileges ──────────────────────────────────────────────────────
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE onesim_production TO onesim_prod;"
sudo -u postgres psql -d onesim_production -c "GRANT ALL ON SCHEMA public TO onesim_prod;"
sudo -u postgres psql -d onesim_production -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO onesim_prod;"
sudo -u postgres psql -d onesim_production -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO onesim_prod;"
sudo -u postgres psql -d onesim_production -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO onesim_prod;"

# ── 4. Verify ────────────────────────────────────────────────────────────────
# Check database exists
psql -h localhost -U onesim_prod -d onesim_production -c "SELECT current_database() AS db_name;"

# Check user can list tables (should be empty)
psql -h localhost -U onesim_prod -d onesim_production -c "\dt"

# Check connection works with a simple query
psql -h localhost -U onesim_prod -d onesim_production -c "SELECT 1 AS ok;"

# ── 5. Production DATABASE_URL ───────────────────────────────────────────────
# Template (replace password):
# DATABASE_URL="postgresql://onesim_prod:YOUR_SECURE_PASSWORD@localhost:5432/onesim_production"

# ── 6. Apply Prisma migrations ──────────────────────────────────────────────
# From the application server (not the DB server):
cd /path/to/onesim-africa
cp .env.production .env   # or set DATABASE_URL in your environment
npx prisma generate
npx prisma migrate deploy

# ── 7. Validate production readiness ─────────────────────────────────────────
psql -h localhost -U onesim_prod -d onesim_production -c "\dt"  # Should list ~30 tables
psql -h localhost -U onesim_prod -d onesim_production -c "SELECT COUNT(*) FROM _prisma_migrations;"  # Should show all migrations applied
