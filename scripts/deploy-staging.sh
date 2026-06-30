#!/bin/bash
set -e

echo "=== OneSim Staging Deployment ==="
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

# Staging specific config
APP_NAME="onesim-staging"
PORT="${PORT:-3001}"
ENV_FILE=".env"

# 1. Pull latest
echo "[1/8] Pulling latest code..."
git pull origin main

# 2. Install dependencies
echo "[2/8] Installing dependencies..."
npm install

# 3. Apply migrations
echo "[3/8] Applying database migrations..."
NODE_ENV=production npx prisma migrate deploy 2>&1 || echo "  (no new migrations)"

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
  PORT=$PORT pm2 restart "$APP_NAME"
else
  echo "  Creating $APP_NAME..."
  PORT=$PORT pm2 start "node_modules/.bin/next start -- -p $PORT" --name "$APP_NAME"
fi
pm2 save

# 7. Verify
echo "[7/8] Verifying deployment..."
sleep 5
if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q 200; then
  echo "  Health check: OK"
else
  echo "  ERROR: Health check failed!"
  pm2 logs "$APP_NAME" --lines 50 --nostream
  exit 1
fi

# 8. Test DB connection
echo "[8/8] Testing DB connection..."
if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/health/db" 2>/dev/null | grep -q 200; then
  echo "  DB health: OK"
else
  echo "  WARNING: DB health check failed!"
fi

echo ""
echo "=== Staging deployment complete! ==="
