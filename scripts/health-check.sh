#!/bin/bash
# Health check script for OneSim
# Usage: ./scripts/health-check.sh [port] [app-name]

PORT="${1:-3001}"
APP_NAME="${2:-onesim-staging}"
BASE="http://127.0.0.1:$PORT"

echo "=== OneSim Health Check ==="
echo "  Port: $PORT"
echo ""

checks=0
passed=0

check() {
  local name="$1"
  local url="$2"
  local expected="${3:-200}"
  checks=$((checks + 1))

  local status=$(curl -s -o /dev/null -w "%{http_code}" "$url" 2>/dev/null || echo "000")
  if [ "$status" = "$expected" ]; then
    echo "  ✓ $name (HTTP $status)"
    passed=$((passed + 1))
  else
    echo "  ✗ $name (HTTP $status, expected $expected)"
  fi
}

check "App Health" "$BASE/api/health"
check "DB Health" "$BASE/api/health/db"
check "Provider Health" "$BASE/api/health/providers"
check "Cron Health" "$BASE/api/health/cron"

echo ""
echo "Results: $passed/$checks passed"

if [ "$passed" -lt "$checks" ]; then
  echo "WARNING: Some checks failed!"
  exit 1
fi

echo "All checks passed!"
exit 0
