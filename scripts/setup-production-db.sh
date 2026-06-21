#!/usr/bin/env bash
# =============================================================================
# OneSim Africa – Production Database Setup
# Target: m2m.onetelecom.cloud
# Database: onesim_production
# User:     onesim_prod
# =============================================================================
set -euo pipefail

echo "=== OneSim Africa Production Database Setup ==="
echo ""

# ── Configuration ────────────────────────────────────────────────────────────
DB_NAME="onesim_production"
DB_USER="onesim_prod"
# Generate a 32-character secure password
DB_PASS=$(openssl rand -base64 24 | tr -dc 'A-Za-z0-9_-' | head -c 32)

echo "  Database: ${DB_NAME}"
echo "  User:     ${DB_USER}"
echo "  Password: ${DB_PASS}"
echo ""

# ── Step 1: Create database ─────────────────────────────────────────────────
echo ">>> Creating database ${DB_NAME}..."
sudo -u postgres psql -c "CREATE DATABASE ${DB_NAME};"

# ── Step 2: Create user ─────────────────────────────────────────────────────
echo ">>> Creating user ${DB_USER}..."
sudo -u postgres psql -c "CREATE USER ${DB_USER} WITH PASSWORD '${DB_PASS}';"

# ── Step 3: Grant privileges ────────────────────────────────────────────────
echo ">>> Granting privileges..."
# Full ownership of the database
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE ${DB_NAME} TO ${DB_USER};"

# Connect to the new database to grant schema-level permissions
sudo -u postgres psql -d "${DB_NAME}" -c "GRANT ALL ON SCHEMA public TO ${DB_USER};"
sudo -u postgres psql -d "${DB_NAME}" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO ${DB_USER};"
sudo -u postgres psql -d "${DB_NAME}" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO ${DB_USER};"
sudo -u postgres psql -d "${DB_NAME}" -c "ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON FUNCTIONS TO ${DB_USER};"

# ── Step 4: Verify ──────────────────────────────────────────────────────────
echo ""
echo "=== Verification ==="

echo ">>> Database list:"
sudo -u postgres psql -c "\l" | grep -E "${DB_NAME}|Name"

echo ""
echo ">>> User list:"
sudo -u postgres psql -c "\du" | grep -E "${DB_USER}|Role"

echo ""
echo ">>> Connection test:"
PGPASSWORD="${DB_PASS}" psql -h localhost -U "${DB_USER}" -d "${DB_NAME}" -c "SELECT 1 AS connection_ok;" 2>&1 || {
    echo "WARNING: Local connection test failed — the server may use a different host/port."
    echo "         Adjust -h/-p flags or run from the app server."
}

# ── Step 5: Output connection string ────────────────────────────────────────
echo ""
echo "=== Production DATABASE_URL ==="
echo "DATABASE_URL=\"postgresql://${DB_USER}:${DB_PASS}@localhost:5432/${DB_NAME}\""
echo ""
echo "=== Save securely ==="
echo "Store the password in your password manager: ${DB_PASS}"
echo ""
