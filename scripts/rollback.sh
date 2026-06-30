#!/bin/bash
set -e

echo "=== OneSim Rollback ==="

APP_NAME="${1:-onesim-production}"
TAG="${2:-previous-deploy}"

echo "  App: $APP_NAME"
echo "  Target: $TAG"
echo ""
read -p "Rollback to previous deployment? [y/N] " -n 1 -r
echo
if [[ ! $REPLY =~ ^[Yy]$ ]]; then
  echo "Rollback cancelled."
  exit 1
fi

# Git rollback
echo "[1/3] Rolling back git..."
git reflog --all --max-count=5
echo ""
read -p "Enter commit hash to rollback to: " COMMIT_HASH

if [ -z "$COMMIT_HASH" ]; then
  echo "ERROR: No commit hash provided."
  exit 1
fi

git reset --hard "$COMMIT_HASH"

# Rebuild and restart
echo "[2/3] Rebuilding..."
npm install
npx prisma generate
npm run build

echo "[3/3] Restarting PM2..."
pm2 restart "$APP_NAME" --update-env
pm2 save

echo ""
echo "=== Rollback complete! ==="
echo "  Deployed commit: $(git log --oneline -1)"
echo "  Run PM2 logs: pm2 logs $APP_NAME --lines 100"
