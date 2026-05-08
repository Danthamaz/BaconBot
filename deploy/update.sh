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

# Restart the service
sudo systemctl restart "$SERVICE_NAME"

echo ""
echo "=== Update complete ==="
sudo systemctl status "$SERVICE_NAME" --no-pager
