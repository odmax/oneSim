#!/bin/bash
set -e

echo "=== OneSim Staging Deployment ==="
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Staging specific config
APP_NAME="onesim-test"
PORT="${PORT:-3001}"
ENV_FILE=".env"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found!"
  exit 1
fi

# 1. Pull latest
echo "[1/8] Pulling latest code..."
git pull origin staging

# 2. Install dependencies
echo "[2/8] Installing dependencies..."
npm install

# 3. Apply migrations
echo "[3/8] Applying database migrations..."
source "$(dirname "$0")/lib/db-identity-guard.sh"
require_db_identity "onesim_staging"
npx prisma migrate deploy

# 4. Generate Prisma client
echo "[4/8] Generating Prisma client..."
npx prisma generate

# 5. Build
echo "[5/8] Building application..."
npm run build

# 6. Start/restart PM2
echo "[6/8] Starting PM2 process..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  echo "  Restarting $APP_NAME..."
  PORT=$PORT pm2 restart "$APP_NAME" --update-env
else
  echo "  Creating $APP_NAME..."
  PORT=$PORT pm2 start "node_modules/.bin/next start -- -p $PORT" --name "$APP_NAME" --update-env
fi
pm2 save

# 7. Verify with retries
echo "[7/8] Verifying deployment..."
for i in 1 2 3 4 5; do
  sleep 3
  HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/health" 2>/dev/null || echo "000")
  if [ "$HTTP_CODE" = "200" ]; then
    echo "  Health check: OK (attempt $i)"
    break
  fi
  echo "  Health check: HTTP $HTTP_CODE (attempt $i)"
  if [ "$i" = "5" ]; then
    echo "  ERROR: Health check failed after 5 attempts!"
    pm2 logs "$APP_NAME" --lines 50 --nostream
    exit 1
  fi
done

# 8. Test DB connection
echo "[8/8] Testing DB connection..."
DB_RESPONSE=$(curl -s "http://127.0.0.1:$PORT/api/health/db" 2>/dev/null || echo '{}')
DB_STATUS=$(echo "$DB_RESPONSE" | grep -o '"status":"[^"]*"' | cut -d'"' -f4)
DB_LATENCY=$(echo "$DB_RESPONSE" | grep -o '"latencyMs":[0-9]*' | cut -d: -f2)

if [ "$DB_STATUS" = "healthy" ]; then
  echo "  DB health: OK (${DB_LATENCY}ms)"
else
  DB_ERROR=$(echo "$DB_RESPONSE" | grep -o '"error":"[^"]*"' | cut -d'"' -f4)
  echo "  WARNING: DB health check failed: ${DB_ERROR:-unknown}"
  echo "  The app is running but database connection may need attention."
fi

echo ""
echo "=== Staging deployment complete! ==="
echo "  App:     $APP_NAME (port $PORT)"
echo "  Health:  http://127.0.0.1:$PORT/api/health"
echo "  DB:      http://127.0.0.1:$PORT/api/health/db"
echo "  PM2:     pm2 show $APP_NAME"
echo "  Logs:    pm2 logs $APP_NAME"
