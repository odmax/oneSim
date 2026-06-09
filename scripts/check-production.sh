#!/bin/bash
set -e

echo "=== OneSim Production Health Check ==="
echo ""

APP_NAME="${PM2_APP_NAME:-onesim-test}"
PORT="${PORT:-3001}"
PUBLIC_URL="${PUBLIC_URL:-https://staging.onetelecom.cloud}"
PASSED=0
FAILED=0

check() {
  local label="$1"
  shift
  if eval "$@" > /dev/null 2>&1; then
    echo "  ✅ $label"
    PASSED=$((PASSED + 1))
  else
    echo "  ❌ $label"
    FAILED=$((FAILED + 1))
  fi
}

echo "1. PM2 Process Status"
check "PM2 '$APP_NAME' is online" pm2 describe "$APP_NAME" 2>/dev/null

echo ""
echo "2. Port Listening"
if command -v ss &> /dev/null; then
  check "Port $PORT is listening" ss -tulpn | grep -q ":$PORT "
elif command -v netstat &> /dev/null; then
  check "Port $PORT is listening" netstat -tulpn 2>/dev/null | grep -q ":$PORT "
fi

echo ""
echo "3. Local Health Endpoint"
check "GET /api/health returns 200" curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/health" | grep -q "200"

echo ""
echo "4. Health Response Valid"
HEALTH_BODY=$(curl -s "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo "")
check "Health response has success=true" echo "$HEALTH_BODY" | grep -q '"success":true'
check "Health response has status=ok" echo "$HEALTH_BODY" | grep -q '"status":"ok"'
check "Health response has uptime" echo "$HEALTH_BODY" | grep -q '"uptime"'
check "Health response has version" echo "$HEALTH_BODY" | grep -q '"version"'

echo ""
echo "5. Public Domain"
check "Public URL $PUBLIC_URL is not 502" curl -s -o /dev/null -w "%{http_code}" "$PUBLIC_URL" 2>/dev/null | grep -v -q "502"
check "Public URL $PUBLIC_URL returns valid status" curl -s -I "$PUBLIC_URL" 2>/dev/null | head -1 | grep -q -E "200|301|302|307|308"

echo ""
echo "=== Results: $PASSED passed, $FAILED failed ==="

if [ "$FAILED" -gt 0 ]; then
  echo ""
  echo "Last 20 lines of PM2 logs:"
  pm2 logs "$APP_NAME" --lines 20 --nostream 2>/dev/null || true
  exit 1
fi
