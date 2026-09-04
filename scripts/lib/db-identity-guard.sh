#!/bin/bash
# =============================================================================
# OneSim Africa — Database Identity Guard
# =============================================================================
# Verifies that the resolved DATABASE_URL points to the expected database
# BEFORE any destructive operation (prisma migrate deploy, etc.).
#
# Usage in deployment scripts:
#   source "$(dirname "$0")/lib/db-identity-guard.sh"
#   require_db_identity "onesim_staging"    # staging
#   require_db_identity "onesim_production" # production
#
# Rules:
#   - Never prints the password or full DATABASE_URL
#   - Fails if DATABASE_URL is missing
#   - Fails if URL cannot be parsed
#   - Fails if database name does not match expected
#   - Exits nonzero (1) before any Prisma command can execute
# =============================================================================

require_db_identity() {
  local expected_db="$1"

  if [ -z "$expected_db" ]; then
    echo "FATAL: require_db_identity called without expected database name" >&2
    exit 1
  fi

  local db_url="${DATABASE_URL:-}"

  if [ -z "$db_url" ]; then
    echo "FATAL: DATABASE_URL is not set. Refusing to proceed." >&2
    exit 1
  fi

  # Extract database name from PostgreSQL URL
  # Format: postgresql://user:password@host:port/dbname?params
  # Strip query string, then take the last path segment
  local without_query="${db_url%%\?*}"
  local db_name="${without_query##*/}"

  if [ -z "$db_name" ]; then
    echo "FATAL: Could not parse database name from DATABASE_URL." >&2
    exit 1
  fi

  if [ "$db_name" != "$expected_db" ]; then
    echo "FATAL: DATABASE identity check FAILED." >&2
    echo "  Expected database: $expected_db" >&2
    echo "  Resolved database: $db_name" >&2
    echo "  Refusing to migrate. Fix your environment configuration." >&2
    exit 1
  fi

  echo "  DB identity OK: connected to $db_name"
}
