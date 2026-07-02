# Web-App Voice Channel Setting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the officer web app pick which Discord voice channel is inspected for attendance validation, via a Settings-tab dropdown, without touching the bot's automatic event tracking.

**Architecture:** Stateless query-param override. The bot's `/voice-members` endpoint accepts an optional `?channel=<id>`; a new `/voice-channels` endpoint lists the guild's voice channels. The web app stores the chosen channel ID in its local `config.json` and appends it to every `voice-members` request. The bot never persists the choice; `RAID_VOICE_CHANNEL_ID` remains the default and `lib/event-tracker.js` is untouched.

**Tech Stack:** Node.js (plain `http`, no framework), discord.js v14, vanilla JS frontend.

**Spec:** `docs/superpowers/specs/2026-07-02-voice-channel-setting-design.md`

## Global Constraints

- **No test framework exists in this project** (per CLAUDE.md: manual testing only). Verification steps use `node --check` for syntax and `curl` / browser checks for behavior. Do not add a test framework.
- The web app lives in `Bacon Bot Distribution/` inside this repo; edit files there directly.
- Empty string `''` for `voiceChannelId` means "server default" — no query param is sent.
- `lib/event-tracker.js` must NOT be modified.
- Config key name is exactly `voiceChannelId` everywhere (server config, POST handler, frontend).
- Do not fix unrelated formatting issues in touched files (e.g. the misindented `for` loop at `Bacon Bot Distribution/web-app.js:434`) — leave surrounding code as-is.

---

### Task 1: Bot API — channel override + channel listing

**Files:**
- Modify: `lib/api-server.js` (imports at line 14, `/voice-members` handler at lines 102–113, new endpoint after line 130)

**Interfaces:**
- Consumes: existing `_client` (discord.js Client), `send(res, status, data)` helper, `parsedUrl` (a `URL` object already defined at line 49).
- Produces: `GET /voice-members?channel=<id>` (optional param; response shape unchanged: `{ members: [...] }`) and `GET /voice-channels` → `200 { channels: [{ id: string, name: string }] }` sorted by name. Both behind the existing `x-api-key` auth (which wraps the whole server). Task 2 depends on both.

- [ ] **Step 1: Add `ChannelType` to the discord.js import**

At `lib/api-server.js:14`, change:

```js
const { EmbedBuilder } = require('discord.js');
```

to:

```js
const { EmbedBuilder, ChannelType } = require('discord.js');
```

- [ ] **Step 2: Accept `?channel=` in `/voice-members`**

Replace the top of the `/voice-members` handler (currently lines 102–107):

```js
    // GET /voice-members — current raid voice channel members
    if (req.method === 'GET' && pathname === '/voice-members') {
      const raidVoiceChannelId = process.env.RAID_VOICE_CHANNEL_ID;
      if (!raidVoiceChannelId || !_client) {
        return send(res, 503, { error: 'Voice tracking not available' });
      }
```

with:

```js
    // GET /voice-members — current raid voice channel members
    // Optional ?channel=<id> overrides RAID_VOICE_CHANNEL_ID.
    if (req.method === 'GET' && pathname === '/voice-members') {
      const raidVoiceChannelId = parsedUrl.searchParams.get('channel') || process.env.RAID_VOICE_CHANNEL_ID;
      if (!raidVoiceChannelId || !_client) {
        return send(res, 503, { error: 'Voice tracking not available' });
      }
```

The rest of the handler already uses the local `raidVoiceChannelId` variable (line 113), so no further change is needed in it.

- [ ] **Step 3: Add the `/voice-channels` endpoint**

Insert immediately after the `/voice-members` handler's closing brace (after current line 130, before the `// POST /link-character` comment):

```js
    // GET /voice-channels — list the guild's voice channels
    if (req.method === 'GET' && pathname === '/voice-channels') {
      if (!_client) return send(res, 503, { error: 'Bot not ready' });
      try {
        const guild = _client.guilds.cache.first();
        if (!guild) return send(res, 503, { error: 'No guild available' });

        const channels = guild.channels.cache
          .filter(c => c.type === ChannelType.GuildVoice)
          .map(c => ({ id: c.id, name: c.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
        return send(res, 200, { channels });
      } catch (err) {
        console.error('[API] /voice-channels error:', err.message);
        return send(res, 500, { error: err.message });
      }
    }
```

Note: `guild.channels.cache` is a discord.js Collection; `.map()` on a Collection returns a plain array, so `.sort()` works on the result.

- [ ] **Step 4: Verify syntax**

Run: `node --check lib/api-server.js`
Expected: no output, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add lib/api-server.js
git commit -m "feat: voice channel override param and channel listing endpoint"
```

---

### Task 2: Web app server — config key, proxy route, call-site updates

**Files:**
- Modify: `Bacon Bot Distribution/web-app.js` (DEFAULT_CONFIG at lines 19–30, config POST handler at lines 318–333, apiGet helper area ~line 49, voice-members call sites at lines 230, 429, 494, 566, new proxy route after line 499)

**Interfaces:**
- Consumes: Task 1's `GET /voice-members?channel=` and `GET /voice-channels`; existing `loadConfig()`, `apiGet(url, key)`, `json(status, data)` helpers.
- Produces: `voiceMembersUrl()` (module-level function returning the full bot URL, with `?channel=` appended when configured); `GET /api/voice-channels` proxy route → same body as the bot's `/voice-channels`; `voiceChannelId` persisted through `POST /api/config`. Task 3 depends on the proxy route and the config key.

- [ ] **Step 1: Add `voiceChannelId` to DEFAULT_CONFIG**

In `Bacon Bot Distribution/web-app.js`, add one line to `DEFAULT_CONFIG` (after `starredItems: [],` at line 29):

```js
  starredItems: [],
  voiceChannelId: '',                // '' = use the bot's RAID_VOICE_CHANNEL_ID
```

- [ ] **Step 2: Add a `voiceMembersUrl()` helper**

Insert after the `saveConfig` function (after line 45, before the `// ── HTTP helpers` comment):

```js
function voiceMembersUrl() {
  const { voiceChannelId } = loadConfig();
  return voiceChannelId
    ? `${serverUrl}/voice-members?channel=${encodeURIComponent(voiceChannelId)}`
    : `${serverUrl}/voice-members`;
}
```

Re-reading config at call time means a settings change applies without restarting the web app.

- [ ] **Step 3: Update all four `voice-members` call sites**

Replace `` `${serverUrl}/voice-members` `` with `voiceMembersUrl()` in each of these four `apiGet` calls (the surrounding lines stay exactly as they are):

Line 230 (auto-save flow):
```js
    const voiceResult = await apiGet(voiceMembersUrl(), apiKey);
```

Line 429 (submit/merge flow):
```js
        const voiceResult = await apiGet(voiceMembersUrl(), apiKey);
```

Line 494 (inside the `/api/voice-members` proxy route):
```js
        const result = await apiGet(voiceMembersUrl(), apiKey);
```

Line 566 (live-mode attendance handler):
```js
            const voiceResult = await apiGet(voiceMembersUrl(), apiKey);
```

After this step, `grep -n 'serverUrl}/voice-members' "Bacon Bot Distribution/web-app.js"` must return nothing.

- [ ] **Step 4: Add the `/api/voice-channels` proxy route**

Insert immediately after the `/api/voice-members` route's closing brace (after current line 499, before the `// ── POST /api/link-character` comment):

```js
    // ── GET /api/voice-channels ────────────────────────────────
    if (req.method === 'GET' && route === '/api/voice-channels') {
      if (!apiKey) return json(500, { error: 'API_KEY not configured in .env' });
      try {
        const result = await apiGet(`${serverUrl}/voice-channels`, apiKey);
        return json(result.status, result.body);
      } catch (err) {
        return json(502, { error: err.message });
      }
    }
```

- [ ] **Step 5: Persist `voiceChannelId` through the config POST handler**

In the `POST /api/config` handler, add one line after `if (body.starredItems !== undefined)  cfg.starredItems  = body.starredItems;` (line 332):

```js
      if (body.voiceChannelId !== undefined) cfg.voiceChannelId = body.voiceChannelId;
```

- [ ] **Step 6: Verify syntax**

Run: `node --check "Bacon Bot Distribution/web-app.js"`
Expected: no output, exit code 0.

- [ ] **Step 7: Commit**

```bash
git add "Bacon Bot Distribution/web-app.js"
git commit -m "feat: web app sends configured voice channel to voice-members"
```

---

### Task 3: Settings UI — dropdown

**Files:**
- Modify: `Bacon Bot Distribution/public/index.html` (Settings view, after the EverQuest Folder form-group ending at line 161)
- Modify: `Bacon Bot Distribution/public/app.js` (`loadConfig` at lines 96–135, `saveSettings` at lines 137–173)

**Interfaces:**
- Consumes: Task 2's `GET /api/voice-channels` (`{ channels: [{ id, name }] }`) and the `voiceChannelId` key on `GET/POST /api/config`. Existing `$(id)` helper and global `config` object in `app.js`.
- Produces: user-facing dropdown; no downstream code consumers.

- [ ] **Step 1: Add the dropdown to the Settings form**

In `Bacon Bot Distribution/public/index.html`, insert after the EverQuest Folder form-group (after line 161, before the `form-actions` div):

```html
        <div class="form-group">
          <label for="cfg-voicechannel">Raid Voice Channel <span class="hint">(checked for attendance validation)</span></label>
          <select id="cfg-voicechannel">
            <option value="">Server default</option>
          </select>
          <div id="voicechannel-note" class="hint hidden">Couldn't load the channel list from the bot — your saved choice is kept.</div>
        </div>
```

- [ ] **Step 2: Populate the dropdown in `app.js`**

Add this function directly after the `loadConfig` function (after line 135):

```js
async function populateVoiceChannels(selectedId) {
  const sel  = $('cfg-voicechannel');
  const note = $('voicechannel-note');
  sel.innerHTML = '<option value="">Server default</option>';
  let loaded = false;
  try {
    const res  = await fetch('/api/voice-channels');
    const data = await res.json();
    if (res.ok && Array.isArray(data.channels)) {
      for (const ch of data.channels) {
        const opt = document.createElement('option');
        opt.value = ch.id;
        opt.textContent = ch.name;
        sel.appendChild(opt);
      }
      loaded = true;
    }
  } catch {}
  // Keep a saved selection visible even if it's not in the fetched list
  if (selectedId && ![...sel.options].some(o => o.value === selectedId)) {
    const opt = document.createElement('option');
    opt.value = selectedId;
    opt.textContent = `Saved channel (${selectedId})`;
    sel.appendChild(opt);
  }
  sel.value = selectedId || '';
  note.classList.toggle('hidden', loaded);
}
```

- [ ] **Step 3: Call it from `loadConfig` and save it in `saveSettings`**

In `loadConfig()`, after `$('cfg-eqfolder').value  = config.eqFolder  || '';` (line 102), add:

```js
    populateVoiceChannels(config.voiceChannelId || '');
```

(Deliberately not awaited — settings fields shouldn't block on the bot round-trip.)

In `saveSettings()`, after `config.eqFolder  = $('cfg-eqfolder').value.trim();` (line 140), add:

```js
  config.voiceChannelId = $('cfg-voicechannel').value;
```

- [ ] **Step 4: Verify in the browser**

Run: `cd "Bacon Bot Distribution" && node web-app.js`, open `http://localhost:3456`, go to the Settings tab.

Expected:
- Dropdown "Raid Voice Channel" appears with "Server default" selected.
- If the VM bot is already redeployed (Task 4) it lists the guild's voice channels by name; otherwise the note "Couldn't load the channel list…" appears — both are acceptable at this stage.
- Pick a value, click Save Settings, then check `Bacon Bot Distribution/config.json` contains `"voiceChannelId": "<the id>"`. Reload the page — the selection persists.

Stop the web app afterwards.

- [ ] **Step 5: Commit**

```bash
git add "Bacon Bot Distribution/public/index.html" "Bacon Bot Distribution/public/app.js"
git commit -m "feat: voice channel dropdown in web app settings"
```

---

### Task 4: Deploy bot to VM and verify end-to-end

**Files:** none (deployment + verification only)

**Interfaces:**
- Consumes: everything from Tasks 1–3.
- Produces: running production bot with the new endpoints.

Deployment reference (from project memory; verify IP against `Bacon Bot Distribution/.env` `SERVER_URL` if unsure — 92-day-old notes):
- SSH: `ssh -i ~/.ssh/id_ed25519 opc@129.146.22.185`
- Update: `ssh -i ~/.ssh/id_ed25519 opc@129.146.22.185 "bash ~/bacon-bot/deploy/update.sh"` (preserves `.env`, `node_modules`, `raid_data.db`)
- Logs: `sudo journalctl -u bacon-bot -f`

- [ ] **Step 1: Push the bot change**

```bash
git push
```

(The VM update script pulls from the repo.)

- [ ] **Step 2: Run the update script on the VM**

Run: `ssh -i ~/.ssh/id_ed25519 opc@129.146.22.185 "bash ~/bacon-bot/deploy/update.sh"`
Expected: script completes; service restarts without errors. If unsure, check `ssh ... "sudo systemctl status bacon-bot"` shows `active (running)`.

- [ ] **Step 3: Verify the new endpoint from the local machine**

Using the `API_KEY` and server host from `Bacon Bot Distribution/.env`:

```bash
curl -s -H "x-api-key: $API_KEY" "$SERVER_URL/voice-channels"
```

Expected: `{"channels":[{"id":"...","name":"..."} , ...]}` listing the guild's voice channels.

```bash
curl -s -H "x-api-key: $API_KEY" "$SERVER_URL/voice-members?channel=<one-of-the-ids>"
```

Expected: `{"members":[...]}` (empty array is fine if nobody is in voice). Also confirm the no-param form still works: `curl -s -H "x-api-key: $API_KEY" "$SERVER_URL/voice-members"` returns 200 (or the pre-existing 503 if `RAID_VOICE_CHANNEL_ID` is unset on the VM).

- [ ] **Step 4: End-to-end check through the web app**

Start the web app, open Settings — the dropdown now lists real channel names. Select a channel, save, then:

```bash
curl -s http://localhost:3456/api/voice-members
```

Expected: 200 with members from the *selected* channel (verify by joining that voice channel in Discord and seeing yourself listed, or by selecting a channel someone is sitting in).

- [ ] **Step 5: Done — no commit needed**

Report results, including any deviation found during deployment (e.g. changed VM IP).
