# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

BaconBot is an EverQuest (Project Quarm) raid tracker Discord bot. It parses EQ client log files to extract raid attendance and loot data, stores it in SQLite, and exposes it via Discord slash commands.

## Commands

```bash
# Install dependencies
npm install

# Register slash commands with Discord (run after adding/changing commands)
npm run deploy

# Start the bot
npm run start
```

The bot requires a `.env` file (copy from `.env.example`) with:
- `DISCORD_TOKEN` — bot token from Discord Developer Portal
- `CLIENT_ID` — application/client ID
- `GUILD_ID` — target Discord server ID

## Architecture

### Entry Points
- `index.js` — bot startup, loads commands from `commands/` dynamically, registers event handlers
- `deploy-commands.js` — one-time slash command registration to Discord API

### Core Libraries (`lib/`)
- `lib/db.js` — all SQLite operations. Schema: `raids`, `attendance`, `loot`, `player_aliases` tables. Uses `better-sqlite3` (synchronous). Call `initSchema()` on startup. Character resolution (`resolveCharacterNames()`) expands a Discord ID or character name to all linked alts.
- `lib/parser.js` — regex-based EQ log parser. Parses bracketed timestamps, zone transitions (`You have entered`), `/who` output, and loot events. Accepts a time window and zone filter.

### Commands (`commands/`)
Each file exports a `data` (SlashCommandBuilder) and `execute(interaction)`. Five commands:
- `parse.js` — accepts a log file (Discord attachment or local path), calls the parser, bulk-inserts via `db.insertRaid()`
- `raids.js` — list/info/delete raid records
- `attendance.js` — attendance by raid ID or by player (resolves alts)
- `loot.js` — loot by raid, player, or item name
- `players.js` — link/unlink/list characters to Discord users via `player_aliases`

### Data Flow
1. User uploads EQ log → `/parse` streams it, runs `parser.parseLogFile()`
2. Parser returns `{ raidName, zone, startTime, endTime, attendees[], loot[] }`
3. `db.insertRaid()` wraps everything in a transaction
4. Subsequent queries resolve Discord ID → all linked character names → aggregate results

### Key Design Decisions
- **Synchronous SQLite** (`better-sqlite3`) — intentional; simplifies command handlers (no async/await for DB calls)
- **Discord ID as identity** — no "main" character concept; one Discord user can have many linked characters
- **No test framework** — no tests exist; manual testing via Discord
- **Database file** — `raid_data.db` at project root, auto-created on first run
