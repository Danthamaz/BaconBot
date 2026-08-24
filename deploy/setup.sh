#!/bin/bash
# =============================================================================
# BaconBot - Oracle Cloud VM Setup Script
# Run this ONCE on the VM to install BaconBot alongside TiltedBot.
#
# Prerequisites: Node.js already installed (shared with TiltedBot)
#
# Usage:
#   1. SSH into your VM
#   2. curl the tarball and extract (see steps below)
#   3. Run: chmod +x ~/bacon-bot/deploy/setup.sh && ~/bacon-bot/deploy/setup.sh
# =============================================================================

set -euo pipefail

APP_DIR="$HOME/bacon-bot"
SERVICE_NAME="bacon-bot"

echo "=== BaconBot VM Setup ==="

# --- 1. Check Node.js is available (should already be from TiltedBot) ---
echo "[1/5] Checking Node.js..."
if ! command -v node &>/dev/null; then
    echo "ERROR: Node.js not found. It should already be installed for TiltedBot."
    exit 1
fi
echo "Node: $(node -v) | npm: $(npm -v)"

# --- 2. Check build tools for better-sqlite3 ---
echo "[2/5] Checking build tools for better-sqlite3..."
if ! command -v gcc &>/dev/null; then
    echo "Installing build tools (gcc, make, python3)..."
    sudo dnf install -y gcc gcc-c++ make python3
fi
echo "Build tools ready."

# --- 3. Install dependencies ---
echo "[3/5] Installing npm dependencies..."
cd "$APP_DIR"
npm ci --production

# --- 4. Prompt for .env if missing ---
if [ ! -f "$APP_DIR/.env" ]; then
    echo ""
    echo "=== .env file not found ==="
    echo "Create it now. You need these values from the Discord Developer Portal:"
    echo ""
    cp "$APP_DIR/.env.example" "$APP_DIR/.env"
    echo "Copied .env.example -> .env"
    echo "Edit it with: nano $APP_DIR/.env"
    echo ""
    read -rp "Press Enter after you've edited .env to continue..."
fi

# --- 5. Deploy slash commands ---
echo "[4/5] Deploying Discord slash commands..."
cd "$APP_DIR"
node deploy-commands.js

# --- 6. Install systemd service ---
echo "[5/5] Setting up systemd service..."
sudo tee /etc/systemd/system/${SERVICE_NAME}.service > /dev/null <<EOF
[Unit]
Description=BaconBot Discord Bot
After=network.target

[Service]
Type=simple
User=$USER
WorkingDirectory=$APP_DIR
ExecStart=$(which node) index.js
Restart=always
RestartSec=10
StandardOutput=journal
StandardError=journal
SyslogIdentifier=$SERVICE_NAME
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable "$SERVICE_NAME"
sudo systemctl start "$SERVICE_NAME"

echo ""
echo "=== Setup Complete ==="
echo ""
echo "BaconBot is running! Useful commands:"
echo "  sudo systemctl status $SERVICE_NAME    # Check status"
echo "  sudo journalctl -u $SERVICE_NAME -f    # Live logs"
echo "  sudo systemctl restart $SERVICE_NAME   # Restart"
echo "  sudo systemctl stop $SERVICE_NAME      # Stop"
echo ""
