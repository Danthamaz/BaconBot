# Item Filters + Spell Alerts

**Date:** 2026-03-30

## Problem

Raid leaders need to know when valuable spells or items drop so they can distribute or sell them. Trash drops clutter the loot feed (partially addressed by ignore list), but there's no way to flag high-value items or get notified about them.

## Data Import Pipeline

Parse the Quarm SQL dump (`C:\Apps\quarm\db\quarm_*.sql`) to extract:

1. **Zone list** — from the `zone` table (`short_name`, `long_name`). Used for the zone selector combo box.
2. **Zone item list** — follow the chain: `zone.short_name` → `spawn2.zone` → `spawnentry.npcID` → `npc_types.loottable_id` → `loottable_entries.lootdrop_id` → `lootdrop_entries.item_id` → `items` (id, Name, itemclass, classes, price, nodrop, magic)

**When it runs:** On web app startup, parse the SQL dump and cache results. When the user saves approved zones, rebuild the item list for those zones.

**Storage:** Local SQLite database in the Distribution folder (separate from raid_data.db). Tables: `zones` (short_name, long_name), `zone_items` (item_id, item_name, zone_short_name, plus item metadata).

## Zone Selector

Replace the free-text approved zones textarea in Settings with a combo box:

- Dropdown shows all zones from the `zone` table, sorted alphabetically by `long_name`
- User can type to filter the list
- Selected zones shown as removable tags below the input
- Saves to `config.approvedZones` as before (array of long_name strings)
- Eliminates typo issues — only valid zone names can be selected

## Item Filters Tab

New tab in the web app between Live Mode and Settings.

- **Search box** — filters the cached item list (items that drop in approved zones)
- **Results list** — each item shows name and two action buttons:
  - **Star** — marks as valuable, saved to `config.starredItems`
  - **Trash** — marks as ignored, saved to `config.ignoredItems` (existing feature)
- Items already starred/trashed show their current status
- Clicking again removes the star/trash designation

## Loot Feed Alerts (Web App)

When a starred item appears in the live loot feed:
- Distinct highlight styling (e.g. gold border or background)
- Visually distinguishable from normal and ignored items

## Discord Alerts

When a starred item is looted (detected by the LogWatcher):
- The web app server calls a new bot API endpoint: `POST /alert`
- The bot posts a message to `ALERT_CHANNEL_ID` with the item name, who looted it, and the zone
- Format: embed with item name, looter, zone, timestamp

### Bot API Endpoint

`POST /alert` — accepts `{ itemName, playerName, zone, timestamp }`, posts to ALERT_CHANNEL_ID.

## Config Changes

Add to `config.json`:
- `starredItems: []` — array of item names marked as valuable
- `eqDbPath: "C:\\Apps\\quarm\\db"` — path to the Quarm SQL dump directory

`ignoredItems` already exists.

## Web App LogWatcher Integration

In `_processLine()`, after a loot event is detected and not ignored:
- Check if the item name is in the starred list
- If yes, emit a `starred-loot` event (in addition to the normal `loot` event)
- The web app server handles the `starred-loot` event by calling `POST /alert` on the bot API
