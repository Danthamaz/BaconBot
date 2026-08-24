# BaconBot

A Discord bot that tracks raid attendance and loot for an EverQuest
(Project Quarm / TAKP) guild. It parses EQ client log files, stores raid
data in SQLite, and exposes everything through Discord slash commands:
attendance history, loot records, guild bank ledger, boss time-of-death
tracking, and character-to-Discord-account linking.

## How it works

```
EQ client log file
      |
      v
Companion web app ("Bacon Bot Distribution", runs on a raider's PC)
  - watches the log live during a raid
  - parses /who output, zone changes, and loot messages
      |
      | HTTP POST (x-api-key)
      v
BaconBot (this repo, runs on a server)
  - lib/api-server.js receives parsed raid data
  - lib/db.js writes to SQLite (raid_data.db)
  - Discord slash commands query the same database
```

There is no "main character" concept. Identity is the Discord user: one
user links any number of in-game characters via `/player link`, and all
attendance and loot queries aggregate across a user's linked characters.

## Requirements

- Node.js 20+
- A Discord application + bot token
  (https://discord.com/developers/applications)
- The bot invited to your server with the `bot` and
  `applications.commands` scopes
- Privileged intent: **Server Members Intent** (used for member lists
  and voice attendance), enabled in the Developer Portal

## Setup

```bash
git clone https://github.com/Danthamaz/BaconBot.git
cd BaconBot
npm install

cp .env.example .env     # then fill in the values (see below)

npm run deploy           # register slash commands (rerun after changing any command)
npm run start            # start the bot
```

### Environment variables (`.env`)

| Variable                | Required | Purpose                                                       |
| ----------------------- | -------- | ------------------------------------------------------------- |
| `DISCORD_TOKEN`         | yes      | Bot token from the Discord Developer Portal                   |
| `CLIENT_ID`             | yes      | Application (client) ID                                       |
| `GUILD_ID`              | yes      | Discord server ID the commands are registered to              |
| `CHANNEL_ID`            | no       | If set, slash commands only work in this channel              |
| `RAID_VOICE_CHANNEL_ID` | no       | Voice channel monitored for raid attendance                   |
| `ALERT_CHANNEL_ID`      | no       | Channel for unlinked-player / valuable-loot alerts            |
| `TOD_CHANNEL_ID`        | no       | Channel for boss time-of-death spawn alerts                   |
| `BANK_CHANNEL_ID`       | no       | Extra channel where `/bank` is allowed                        |
| `OFFICER_ROLE_IDS`      | no       | Comma-separated role IDs treated as officers (raid edit/delete, bank writes, PvP targets, unlinking others' characters). Members with the Manage Server permission always qualify. |
| `AUTO_DELETE_CHANNEL_IDS` | no     | Comma-separated channel IDs where unpinned messages auto-delete after 5 minutes (append `:bot` to an ID to only delete the bot's own messages) |
| `EPHEMERAL_CHANNEL_IDS` | no       | Comma-separated channel IDs where all bot replies are forced ephemeral |
| `API_KEY`               | no       | Shared secret for the local REST API. If unset, the API server does not start. Use a long random string. |
| `API_PORT`              | no       | REST API port (default 3001)                                  |

Never commit `.env` -- it is gitignored. If a token ever lands in a
commit, regenerate it in the Developer Portal immediately; deleting the
commit is not enough once the repo is public.

## Slash commands

| Command       | What it does                                                          |
| ------------- | --------------------------------------------------------------------- |
| `/raids`      | List, inspect, edit, and delete recorded raids (edit/delete are officer-only) |
| `/attendance` | Attendance for a raid, or full history for a player (all alts)        |
| `/loot`       | Loot by raid, by player, or search by item name                       |
| `/player`     | Link/unlink characters to Discord users; `chars`, `whois` lookups     |
| `/bank`       | Guild bank inventory and deposit/withdraw ledger (writes are officer-only) |
| `/tod`        | Boss time-of-death tracking with respawn-window spawn alerts          |
| `/key`        | Sleeper's Tomb key holder list                                        |
| `/help`       | Command reference embed                                               |
| `/ping`       | Latency and uptime check                                              |

Run `/help` in Discord for full subcommand syntax.

## The companion app (`Bacon Bot Distribution/`)

A small local web app that raiders run on the machine where EQ is
installed. It tails the live log file, shows a live attendance and loot
view in the browser, and submits parsed results to the bot's REST API.

```bash
cd "Bacon Bot Distribution"
npm install
node web-app.js          # or run web-app.bat on Windows
```

It needs its own `.env` with `API_KEY` (matching the bot's) and
`SERVER_URL` (the bot's API address), plus `config.json` for the EQ
folder path, character name, timezone, raid days, and approved zones.

`lib/parser.js` is shared between the bot and the companion app. After
editing the bot's copy, sync it with:

```bash
npm run sync-dist
```

## Local REST API

`lib/api-server.js` starts an HTTP server (default port 3001) only when
`API_KEY` is set. All endpoints require the `x-api-key` header. It is
intended for the companion app, not the public internet -- firewall the
port or tunnel it (SSH/VPN) rather than exposing it directly, since the
key travels in plain HTTP.

Main endpoints: `POST /raid`, `POST /raid/merge?id=`, `GET /raid?date=`,
`GET /voice-members`, `GET /guild-members`, `GET /voice-channels`,
`POST /link-character`, `GET /character-info?name=`, `GET /all-linked`,
`POST /alert`.

## Data storage

- `raid_data.db` (SQLite, created automatically at the project root)
- Tables: `raids`, `attendance`, `loot`, `player_aliases`, plus tables
  for the guild bank, TOD tracking, and keys
- Uses `better-sqlite3` (synchronous by design -- command handlers stay
  simple, no async DB calls)
- Database files are gitignored; back them up separately

## Deployment

Two reference scripts are included for running on a Linux VM:

- `deploy/setup.sh` -- one-time install as a systemd service
  (`bacon-bot`), prompts for `.env` values
- `deploy/update.sh` -- pulls the latest code from GitHub, preserves
  `.env` and the databases, reinstalls dependencies, redeploys slash
  commands, restarts the service
- `setup-server.sh` -- older PM2-based variant of the setup script

## Project layout

```
index.js                 Bot entry point: loads commands, event handlers, spawn alerts
deploy-commands.js       Registers slash commands with Discord (npm run deploy)
commands/                One file per slash command (data + execute)
lib/db.js                All SQLite operations and schema
lib/parser.js            EQ log parser (timestamps, zones, /who, loot)
lib/api-server.js        REST API for the companion app
lib/event-tracker.js     Voice channel attendance tracking
Bacon Bot Distribution/  Companion live-parse web app for raiders
deploy/                  Server setup and update scripts
docs/                    Design docs and implementation plans
```

## Contributing

- There is no test framework; changes are verified manually against a
  test Discord server. Keep changes small and describe how you tested.
- Each command file exports `data` (a `SlashCommandBuilder`) and
  `execute(interaction)`; new commands are picked up automatically from
  `commands/` at startup, but must be registered with `npm run deploy`.
- Do not commit: `.env`, any `*.db` / `*.db-shm` / `*.db-wal` files,
  `live-session.json`, or zip bundles containing any of those. When in
  doubt, run `git status` and check what you are about to add.
- `CLAUDE.md` documents architecture decisions for AI-assisted
  development and is worth reading before larger changes.
