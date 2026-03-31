# Per-Zone Attendance Tracking

**Date:** 2026-03-30

## Problem

Raids can span multiple zones (e.g., Plane of Fear then Plane of Hate). Currently attendance is one row per character per raid with no zone info. We need per-zone attendance so raid leaders can see who was present in each zone.

## Schema Change

Add a `zone` column to the `attendance` table. A player seen in 2 zones during one raid gets 2 rows.

```sql
ALTER TABLE attendance ADD COLUMN zone TEXT;
```

Dedup key changes from `(raid_id, player_name)` to `(raid_id, player_name, zone)`.

## Database Layer (lib/db.js)

- `saveRaid()` / `mergeIntoRaid()` — accept and insert zone per attendance row
- `getRaidAttendance()` — group by player, aggregate zones into comma-separated string for display
- `getPlayerAttendance()` — include zone info per raid entry
- Existing data with `zone = NULL` continues to work (nullable column)

## Web App Submit (web-app.js + auto-save)

- Before uploading, filter attendance to **only validated players** (green checkmark = in zone + in voice, with a formal character link)
- Strip unlinked players entirely — they do not get attendance credit
- Each attendance entry includes the zone from the `/who` footer — pass it through to the API
- `awardedTo` loot override logic is unchanged

## Discord Commands

- `/attendance raid:5` — one row per player, zones joined inline: `Lyri | Plane of Fear, Plane of Hate | 08:00-09:30`
- `/attendance player:Lyri` — zones shown inline per raid entry: `Raid #5 — 2026-03-29 Sunday | Plane of Fear, Plane of Hate`

## LogWatcher (Bacon Bot Distribution/lib/log-watcher.js)

- The `/who` footer already provides the zone name (`There are X players in ZoneName`)
- Change attendanceMap key from `name` to `name:zone` so a player in two zones gets separate entries
- Each entry stores: `{ name, zone, firstSeen, lastSeen, validated, exitTime, ... }`
- `getSessionData()` returns attendance with zone per entry
- `validatePlayers()` continues to update `lastSeen` only for voice-confirmed players

## API (lib/api-server.js)

- No new endpoints needed
- `POST /raid` and `POST /raid/merge` already accept attendance arrays — rows now include a `zone` field
- `hydrateDates()` passes through the zone field unchanged

## Raid End Time (Web App)

- Add an "End Raid" button to the live mode controls bar
- When clicked, records the current timestamp as the raid end time
- The end time is included in the session data sent on upload/auto-save
- This sets `endTime` on the raid record in the database
- If not explicitly set, `endTime` falls back to the last validated attendance timestamp (current behavior)

## Upload Filtering Rules

Attendance row is uploaded only if ALL of these are true:
1. Character is formally linked to a Discord user (in `player_aliases`)
2. Player is in the Discord voice channel
3. Player's character appeared in a `/who` in an approved zone
4. `validated` flag is true (set by `validatePlayers()`)

Unlinked players are visible in the web app's "Unlinked Players" panel for the raid leader to link, but are never included in uploaded attendance data.
