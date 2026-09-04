#!/bin/bash
set -e

echo "=== OneSim Safe Deployment ==="
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

APP_NAME="${PM2_APP_NAME:-onesim-test}"
PORT="${PORT:-3001}"

# 1. Pull latest
echo "[1/8] Pulling latest code..."
git pull origin staging

# 2. Install dependencies
echo "[2/8] Installing dependencies..."
npm install

# 3. Apply database migrations
echo "[3/8] Applying database migrations..."
source "$(dirname "$0")/lib/db-identity-guard.sh"
require_db_identity "onesim_staging"
npx prisma migrate deploy

# 4. Generate Prisma client
echo "[4/8] Generating Prisma client..."
npx prisma generate

# 5. Clean previous build
echo "[5/8] Cleaning previous build..."
rm -rf .next

# 6. Build
echo "[6/8] Building application..."
npm run build

# 7. Start or restart PM2
echo "[7/8] Starting/restarting PM2 process..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  echo "  PM2 process '$APP_NAME' exists — restarting..."
  PORT=$PORT pm2 restart "$APP_NAME"
else
  echo "  PM2 process '$APP_NAME' not found — creating..."
  PORT=$PORT pm2 start npm --name "$APP_NAME" -- start
fi
pm2 save

# 8. Verify
echo "[8/8] Verifying deployment..."
sleep 5

# Check port
echo "  Checking port $PORT..."
if command -v ss &> /dev/null; then
  if ! ss -tulpn | grep -q ":$PORT "; then
    echo "  ERROR: Port $PORT is not listening!"
    pm2 logs "$APP_NAME" --lines 50 --nostream
    exit 1
  fi
elif command -v netstat &> /dev/null; then
  if ! netstat -tulpn 2>/dev/null | grep -q ":$PORT "; then
    echo "  ERROR: Port $PORT is not listening!"
    pm2 logs "$APP_NAME" --lines 50 --nostream
    exit 1
  fi
fi
echo "  Port $PORT is listening."

# Check health endpoint
echo "  Checking /api/health..."
HEALTH_STATUS=$(curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:$PORT/api/health 2>/dev/null || echo "000")
if [ "$HEALTH_STATUS" != "200" ]; then
  echo "  ERROR: Health endpoint returned HTTP $HEALTH_STATUS!"
  pm2 logs "$APP_NAME" --lines 100 --nostream
  exit 1
fi
echo "  Health endpoint OK (HTTP 200)."

echo ""
echo "=== Deployment complete! ==="
echo "  App:     $APP_NAME"
echo "  Port:    $PORT"
echo "  Health:  http://127.0.0.1:$PORT/api/health"
echo "  PM2:     pm2 show $APP_NAME"
echo "  Logs:    pm2 logs $APP_NAME"
