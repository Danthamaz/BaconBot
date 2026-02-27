#!/bin/bash
# BaconBot server setup script
# Run on a fresh Ubuntu 22.04 Oracle Cloud VM:
#   bash setup-server.sh

set -e  # exit on any error

echo ""
echo "========================================"
echo "  BaconBot Server Setup"
echo "========================================"
echo ""

# ── System update ──────────────────────────────────────────────────────────
echo "[ 1/6 ] Updating system packages..."
sudo apt update -y && sudo apt upgrade -y

# ── Node.js 20 ─────────────────────────────────────────────────────────────
echo ""
echo "[ 2/6 ] Installing Node.js 20..."
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

echo "        Node $(node -v) / npm $(npm -v)"

# ── Git ─────────────────────────────────────────────────────────────────────
echo ""
echo "[ 3/6 ] Installing git..."
sudo apt install -y git

# ── Clone repo ──────────────────────────────────────────────────────────────
echo ""
echo "[ 4/6 ] Cloning BaconBot..."
cd ~
git clone https://github.com/Danthamaz/BaconBot.git
cd BaconBot
npm install
echo "        Dependencies installed."

# ── .env ────────────────────────────────────────────────────────────────────
echo ""
echo "[ 5/6 ] Creating .env file..."
echo "        Enter your Discord bot credentials."
echo "        (Values are not shown as you type)"
echo ""

read -p "        DISCORD_TOKEN : " DISCORD_TOKEN
read -p "        CLIENT_ID     : " CLIENT_ID
read -p "        GUILD_ID      : " GUILD_ID

cat > .env <<EOF
DISCORD_TOKEN=${DISCORD_TOKEN}
CLIENT_ID=${CLIENT_ID}
GUILD_ID=${GUILD_ID}
EOF

echo "        .env written."

# ── PM2 ─────────────────────────────────────────────────────────────────────
echo ""
echo "[ 6/6 ] Installing PM2 and starting bot..."
sudo npm install -g pm2
pm2 start index.js --name baconbot
pm2 startup | tail -1 | sudo bash   # run the generated startup command
pm2 save

echo ""
echo "========================================"
echo "  Setup complete!"
echo ""
echo "  Bot is running. Useful commands:"
echo "    pm2 logs baconbot      — live logs"
echo "    pm2 status             — process status"
echo "    pm2 restart baconbot   — restart bot"
echo "    pm2 stop baconbot      — stop bot"
echo ""
echo "  To pull future updates:"
echo "    cd ~/BaconBot && git pull && pm2 restart baconbot"
echo "========================================"
