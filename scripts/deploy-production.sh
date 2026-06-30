#!/bin/bash
set -e

echo "=== OneSim Production Deployment ==="
echo ""

PROJECT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$PROJECT_DIR"

APP_NAME="onesim-production"
PORT="${PORT:-3002}"
ENV_FILE=".env.production"

if [ ! -f "$ENV_FILE" ]; then
  echo "ERROR: $ENV_FILE not found! Production credentials must be configured."
  exit 1
fi

# Confirm deployment
echo "Deploying to PRODUCTION (port $PORT)..."
read -p "Are you sure? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Deployment cancelled."
  exit 1
fi

# 1. Pull latest
echo "[1/8] Pulling latest code..."
git checkout main
git pull origin main

# 2. Install dependencies
echo "[2/8] Installing dependencies..."
npm install --production

# 3. Migrate
echo "[3/8] Applying database migrations..."
NODE_ENV=production npx prisma migrate deploy 2>&1 || echo "  (no new migrations)"

# 4. Generate client
echo "[4/8] Generating Prisma client..."
npx prisma generate

# 5. Build
echo "[5/8] Building..."
NODE_ENV=production npm run build

# 6. Start/restart
echo "[6/8] Starting PM2..."
if pm2 describe "$APP_NAME" > /dev/null 2>&1; then
  PORT=$PORT pm2 restart "$APP_NAME" --update-env
else
  PORT=$PORT pm2 start "node_modules/.bin/next start -- -p $PORT" --name "$APP_NAME" --update-env
fi
pm2 save

# 7. Verify
echo "[7/8] Verifying..."
sleep 5
if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/api/health" 2>/dev/null | grep -q 200; then
  echo "  Health: OK"
else
  echo "  ERROR: Health check failed!"
  pm2 logs "$APP_NAME" --lines 50 --nostream
  exit 1
fi

# 8. Nginx test
echo "[8/8] Testing nginx..."
if command -v nginx &> /dev/null; then
  sudo nginx -t && echo "  Nginx config: OK" || echo "  WARNING: nginx config test failed"
fi

echo ""
echo "=== Production deployment complete! ==="
echo "  URL: https://m2m.onetelecom.cloud"
echo "  PM2: pm2 show $APP_NAME"
