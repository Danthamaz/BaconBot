#!/bin/bash
# =============================================================================
# BaconBot - Update Script
# Downloads latest code from GitHub and restarts the bot.
# Uses curl (no git required — the VM doesn't have git installed).
#
# Usage: ~/bacon-bot/deploy/update.sh
# =============================================================================

set -euo pipefail

APP_DIR="$HOME/bacon-bot"
SERVICE_NAME="bacon-bot"
REPO_URL="https://github.com/Danthamaz/BaconBot"
BRANCH="master"

echo "=== Updating BaconBot ==="

# Stop the bot first so SQLite WAL is checkpointed cleanly
echo "[0/4] Stopping bot..."
sudo systemctl stop "$SERVICE_NAME" 2>/dev/null || true

# Back up the database before syncing
if [ -f "$APP_DIR/raid_data.db" ]; then
  cp "$APP_DIR/raid_data.db" "$APP_DIR/raid_data.db.bak"
  echo "  Backed up raid_data.db"
fi

# Download latest tarball from GitHub
echo "[1/4] Downloading latest code..."
cd /tmp
curl -sL "${REPO_URL}/archive/refs/heads/${BRANCH}.tar.gz" -o bacon-bot-update.tar.gz
tar xzf bacon-bot-update.tar.gz
rm bacon-bot-update.tar.gz

# Sync files (preserve .env, node_modules, databases)
echo "[2/4] Syncing files..."
rsync -a --delete \
  --exclude='.env' \
  --exclude='node_modules' \
  --exclude='raid_data.db' \
  --exclude='raid_data.db-shm' \
  --exclude='raid_data.db-wal' \
  --exclude='quarm-cache.db' \
  /tmp/BaconBot-${BRANCH}/ "$APP_DIR/"
rm -rf /tmp/BaconBot-${BRANCH}

# Reinstall dependencies (in case they changed)
echo "[3/4] Installing dependencies..."
cd "$APP_DIR"
npm ci --production

# Re-deploy slash commands (in case they changed)
echo "[4/4] Deploying slash commands..."
node deploy-commands.js

# Start the service (was stopped at the beginning)
sudo systemctl start "$SERVICE_NAME"

echo ""
echo "=== Update complete ==="
sudo systemctl status "$SERVICE_NAME" --no-pager
