# Voice Channel Setting — Design

**Date:** 2026-07-02
**Status:** Approved

## Goal

Let the officer web app choose which Discord voice channel is inspected when
validating raid attendance, instead of being locked to the bot's
`RAID_VOICE_CHANNEL_ID` env var.

## Scope decisions (confirmed with user)

- Affects **web app lookups only**. The bot's automatic event tracking
  (`lib/event-tracker.js`) keeps using `RAID_VOICE_CHANNEL_ID` unchanged.
- Channel is picked from a **dropdown of the guild's voice channels** (by
  name), not a manual ID field.
- The picker lives in the **Settings tab only**, persisted to the web app's
  `config.json`.

## Approach

Stateless query-param override. The web app stores the chosen channel ID
locally and passes it on each request; the bot never persists it.

## Changes

### Bot on the VM (`lib/api-server.js`)

1. **New endpoint `GET /voice-channels`** — returns the guild's voice
   channels as `{ channels: [{ id, name }] }`, sorted by name. Same
   `x-api-key` auth as the other endpoints. Uses
   `guild.channels.cache` filtered to voice channels on
   `_client.guilds.cache.first()`.
2. **`GET /voice-members` accepts optional `?channel=<id>`** — when present,
   that channel is inspected instead of `RAID_VOICE_CHANNEL_ID`. When absent,
   behavior is unchanged. If neither the param nor the env var is set, the
   existing 503 `Voice tracking not available` response stays.

`lib/event-tracker.js` is not touched.

### Web app (`Bacon Bot Distribution/`)

1. **`web-app.js` `DEFAULT_CONFIG`** gains `voiceChannelId: ''`. Empty string
   means "server default" (no query param sent).
2. **New proxy route `GET /api/voice-channels`** in `web-app.js`, mirroring
   the existing `/api/voice-members` proxy (forwards to
   `${serverUrl}/voice-channels` with the API key).
3. **All four `voice-members` call sites** in `web-app.js` (submit flow,
   merge flow, live-mode attendance handler, and the `/api/voice-members`
   proxy route the frontend calls for display) append
   `?channel=<voiceChannelId>` when the config value is non-empty. Config is
   re-read via `loadConfig()` at call time so a settings change takes effect
   without restarting the web app.
4. **Settings tab UI** (`public/index.html`, `public/app.js`): a "Raid Voice
   Channel" dropdown, populated from `/api/voice-channels` when the Settings
   view loads. First option is "Server default" (value `''`). Selection is
   saved through the existing Save Settings flow into `config.json`.

## Error handling

- Bot unreachable or not yet redeployed (`/voice-channels` 404s): the
  dropdown falls back to showing the currently saved value plus a note that
  the channel list couldn't be loaded. Settings still save normally.
- Invalid or deleted channel ID: `/voice-members` returns zero members —
  identical to an empty channel today. No new error paths.

## Testing

Manual (project has no test framework): run the web app locally against the
VM, confirm the dropdown lists the server's voice channels, switch channels,
and verify live-mode voice validation follows the selected channel.

## Deployment

The `lib/api-server.js` change must be deployed to the Oracle VM (existing
update script) before the dropdown can populate. The web app change ships by
copying into `Bacon Bot Distribution/`.
