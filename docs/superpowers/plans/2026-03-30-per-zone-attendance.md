# Per-Zone Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Track attendance per-zone within raids, filter uploads to only validated+linked players, and add a raid end time button.

**Architecture:** Add `zone` column to attendance table with composite unique key `(raid_id, player_name, zone)`. LogWatcher keys attendance by `name:zone`. Web app filters to validated players before upload. "End Raid" button stamps end time.

**Tech Stack:** Node.js, better-sqlite3, discord.js, vanilla JS frontend

---

### Task 1: Schema Migration — Add zone column to attendance

**Files:**
- Modify: `lib/db.js` (schema init, lines 47-58)

- [ ] **Step 1: Update CREATE TABLE to include zone column and new unique constraint**

In `lib/db.js`, find the attendance table creation (inside `initSchema()`):

```javascript
    CREATE TABLE IF NOT EXISTS attendance (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      raid_id     INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
      player_name TEXT    NOT NULL,
      level       INTEGER,
      class       TEXT,
      race        TEXT,
      guild       TEXT,
      first_seen  INTEGER,
      last_seen   INTEGER,
      UNIQUE(raid_id, player_name)
    );
```

Replace with:

```javascript
    CREATE TABLE IF NOT EXISTS attendance (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      raid_id     INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
      player_name TEXT    NOT NULL,
      zone        TEXT,
      level       INTEGER,
      class       TEXT,
      race        TEXT,
      guild       TEXT,
      first_seen  INTEGER,
      last_seen   INTEGER,
      UNIQUE(raid_id, player_name, zone)
    );
```

- [ ] **Step 2: Verify the bot starts with a fresh database**

Delete `raid_data.db` (or use a test copy), run `node index.js`, confirm it starts without errors and the schema is created.

- [ ] **Step 3: Commit**

```bash
git add lib/db.js
git commit -m "feat: add zone column to attendance table"
```

---

### Task 2: Update saveRaid() and mergeIntoRaid() to handle zone

**Files:**
- Modify: `lib/db.js` (saveRaid lines ~128-174, mergeIntoRaid lines ~185-234)

- [ ] **Step 1: Update the attendance INSERT in saveRaid()**

Find the attendance prepared statement inside `saveRaid()`:

```javascript
    const insAttend = db.prepare(`
      INSERT OR REPLACE INTO attendance (raid_id, player_name, level, class, race, guild, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
```

Replace with:

```javascript
    const insAttend = db.prepare(`
      INSERT OR REPLACE INTO attendance (raid_id, player_name, zone, level, class, race, guild, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
```

Find where `insAttend.run()` is called and add `a.zone || null`:

```javascript
      insAttend.run(
        raidId, properCase(a.name), a.zone || null,
        a.level ?? null, a.class ?? null, a.race ?? null, a.guild ?? null,
        a.firstSeen ? a.firstSeen.getTime() : null,
        a.lastSeen  ? a.lastSeen.getTime()  : null,
      );
```

- [ ] **Step 2: Update the attendance INSERT in mergeIntoRaid()**

Find the attendance prepared statement inside `mergeIntoRaid()`:

```javascript
    const insAttend = db.prepare(`
      INSERT OR REPLACE INTO attendance (raid_id, player_name, level, class, race, guild, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `);
```

Replace with the same updated version:

```javascript
    const insAttend = db.prepare(`
      INSERT OR REPLACE INTO attendance (raid_id, player_name, zone, level, class, race, guild, first_seen, last_seen)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
```

And update the `.run()` call to include zone:

```javascript
      insAttend.run(
        raidId, properCase(a.name), a.zone || null,
        a.level ?? null, a.class ?? null, a.race ?? null, a.guild ?? null,
        a.firstSeen ? a.firstSeen.getTime() : null,
        a.lastSeen  ? a.lastSeen.getTime()  : null,
      );
```

- [ ] **Step 3: Commit**

```bash
git add lib/db.js
git commit -m "feat: saveRaid/mergeIntoRaid insert zone per attendance row"
```

---

### Task 3: Update getRaidAttendance() and getPlayerAttendance()

**Files:**
- Modify: `lib/db.js` (getRaidAttendance lines ~314-318, getPlayerAttendance lines ~432-443)

- [ ] **Step 1: Update getRaidAttendance() to aggregate zones per player**

Replace the current function:

```javascript
function getRaidAttendance(raidId) {
  return getDb().prepare(
    'SELECT * FROM attendance WHERE raid_id = ? ORDER BY player_name COLLATE NOCASE'
  ).all(raidId);
}
```

With:

```javascript
function getRaidAttendance(raidId) {
  return getDb().prepare(`
    SELECT player_name, GROUP_CONCAT(DISTINCT zone) AS zones,
           MAX(level) AS level, MAX(class) AS class, MAX(race) AS race, MAX(guild) AS guild,
           MIN(first_seen) AS first_seen, MAX(last_seen) AS last_seen
    FROM attendance
    WHERE raid_id = ?
    GROUP BY player_name COLLATE NOCASE
    ORDER BY player_name COLLATE NOCASE
  `).all(raidId);
}
```

This aggregates all zone entries for a player into a comma-separated `zones` field while preserving the widest time range and latest class/level info.

- [ ] **Step 2: Update getPlayerAttendance() to include zone info**

Find the SELECT query in `getPlayerAttendance()` and add zone aggregation:

```javascript
  return db.prepare(`
    SELECT r.id, r.name, r.zone AS raid_zone, r.start_time,
           a.player_name AS character_name, a.level, a.class, a.guild,
           GROUP_CONCAT(DISTINCT a.zone) AS zones
    FROM attendance a
    JOIN raids r ON r.id = a.raid_id
    WHERE a.player_name IN (${placeholders}) COLLATE NOCASE
    GROUP BY r.id, a.player_name
    ORDER BY r.start_time DESC
  `).all(...names);
```

- [ ] **Step 3: Commit**

```bash
git add lib/db.js
git commit -m "feat: aggregate zones in attendance queries"
```

---

### Task 4: Update /attendance command display

**Files:**
- Modify: `commands/attendance.js`

- [ ] **Step 1: Update raid attendance display to show zones per player**

In the `/attendance raid` subcommand, find where player lines are formatted. The `enrichWithDiscordInfo()` output now has a `zones` field (comma-separated string or null). Update the player formatting to include zones.

Find the embed field construction for attendance rows and add zone info. In the class grouping display, after the player name add the zone if present:

```javascript
const zoneSuffix = row.zones ? ` — ${row.zones}` : '';
```

Include `zoneSuffix` in the player line output.

- [ ] **Step 2: Update player attendance display to show zones per raid**

In the `/attendance player` subcommand, find where each raid entry is formatted. Currently it shows:

```javascript
`• **[${r.id}]** ${r.name}${classInfo}${charNote}\n  📅 ${date}  🗺️ ${r.zone}`
```

Change `r.zone` to use the per-player zones:

```javascript
const zones = r.zones || r.raid_zone || 'Unknown';
`• **[${r.id}]** ${r.name}${classInfo}${charNote}\n  📅 ${date}  🗺️ ${zones}`
```

- [ ] **Step 3: Commit**

```bash
git add commands/attendance.js
git commit -m "feat: show per-zone attendance in discord commands"
```

---

### Task 5: LogWatcher — key attendance by name:zone

**Files:**
- Modify: `Bacon Bot Distribution/lib/log-watcher.js`

- [ ] **Step 1: Change attendanceMap key to include zone**

In `_processLine()`, find the `/who` footer handling block where players are added to attendanceMap (around line 148-158). Currently the key is `p.name.toLowerCase()`. Change it to include the zone from the `/who` footer:

```javascript
        const newPlayers = [];
        for (const p of this.whoPlayers) {
          const key = `${p.name.toLowerCase()}:${whoZone.toLowerCase()}`;
          const existing = this.attendanceMap.get(key);
          if (!existing) {
            this.attendanceMap.set(key, { ...p, zone: whoZone, firstSeen: this.whoBlockUTC, lastSeen: this.whoBlockUTC, validated: false });
            newPlayers.push(p);
          }
          // lastSeen is only updated via validatePlayers()
        }
```

- [ ] **Step 2: Update validatePlayers() to use name:zone keys**

Find `validatePlayers()`. Currently it iterates the attendanceMap by name. Update it to extract the name portion from the composite key:

```javascript
  validatePlayers(voiceConfirmedNames) {
    const now = new Date();
    for (const [key, data] of this.attendanceMap) {
      const name = key.split(':')[0];
      if (voiceConfirmedNames.has(name)) {
        data.lastSeen = now;
        data.validated = true;
      }
    }
  }
```

- [ ] **Step 3: Update removePlayer(), markPlayerExited(), clearPlayerExit()**

These currently look up by `name.toLowerCase()`. Update them to match any key starting with that name:

```javascript
  removePlayer(name) {
    const prefix = name.toLowerCase() + ':';
    let removed = false;
    for (const key of this.attendanceMap.keys()) {
      if (key === name.toLowerCase() || key.startsWith(prefix)) {
        this.attendanceMap.delete(key);
        removed = true;
      }
    }
    return removed;
  }

  markPlayerExited(name) {
    const prefix = name.toLowerCase() + ':';
    let found = false;
    for (const [key, player] of this.attendanceMap) {
      if (key === name.toLowerCase() || key.startsWith(prefix)) {
        player.exitTime = new Date();
        found = true;
      }
    }
    return found;
  }

  clearPlayerExit(name) {
    const prefix = name.toLowerCase() + ':';
    let found = false;
    for (const [key, player] of this.attendanceMap) {
      if (key === name.toLowerCase() || key.startsWith(prefix)) {
        delete player.exitTime;
        found = true;
      }
    }
    return found;
  }
```

- [ ] **Step 4: Update allPlayersWithTime emission to include zone and dedupe by name for display**

In the attendance event emission and the attendance-update broadcast, the frontend needs deduplicated-by-name players (a player in 2 zones should appear once in the UI). Build a deduped view:

```javascript
        // Build deduped player list for UI (one row per player, aggregate zones)
        const playerMap = new Map();
        for (const [key, data] of this.attendanceMap) {
          const name = data.name.toLowerCase();
          const existing = playerMap.get(name);
          if (!existing) {
            playerMap.set(name, {
              name: data.name,
              zones: [data.zone],
              lastSeen: data.lastSeen,
              exitTime: data.exitTime || null,
              validated: !!data.validated,
            });
          } else {
            if (data.zone && !existing.zones.includes(data.zone)) existing.zones.push(data.zone);
            if (data.lastSeen > existing.lastSeen) existing.lastSeen = data.lastSeen;
            if (data.validated) existing.validated = true;
            if (data.exitTime && (!existing.exitTime || data.exitTime > existing.exitTime)) existing.exitTime = data.exitTime;
          }
        }
        const allPlayersWithTime = Array.from(playerMap.values()).map(p => ({
          name: p.name,
          zones: p.zones,
          lastSeen: p.lastSeen.toISOString(),
          exitTime: p.exitTime ? p.exitTime.toISOString() : null,
          validated: p.validated,
        }));
```

Use this deduped list in both the `attendance` event emission and the `attendance-update` SSE broadcast in `web-app.js`.

- [ ] **Step 5: Update getSessionData() to include zone per entry**

In `getSessionData()`, the attendance array is built from `this.attendanceMap.values()`. Each entry now has a `zone` field. No change needed — it already spreads all properties. Verify the zone field is present in the output.

- [ ] **Step 6: Commit**

```bash
git add "Bacon Bot Distribution/lib/log-watcher.js"
git commit -m "feat: LogWatcher tracks attendance per name:zone"
```

---

### Task 6: Web app — filter uploads to validated+linked players only

**Files:**
- Modify: `Bacon Bot Distribution/web-app.js`

- [ ] **Step 1: Add filtering in autoSaveLiveSession()**

After `const session = liveWatcher.getSessionData();`, filter attendance to only validated players. Also fetch voice members to check linking:

```javascript
  // Filter attendance to only validated (in-zone + in-voice + linked) players
  let attendance = session.attendance;
  try {
    const voiceResult = await apiGet(`${serverUrl}/voice-members`, apiKey);
    if (voiceResult.status === 200 && voiceResult.body.members) {
      const linkedChars = new Set();
      for (const vm of voiceResult.body.members) {
        if (vm.character) linkedChars.add(vm.character.toLowerCase());
      }
      attendance = attendance.filter(a => a.validated && linkedChars.has(a.name.toLowerCase()));
    }
  } catch {}
  if (attendance.length === 0 && loot.length === 0) return;
```

Replace `session.attendance` with `attendance` in the API calls below.

- [ ] **Step 2: Add same filtering in POST /api/submit handler**

In the submit handler, after parsing the body, add the same voice-based filtering:

```javascript
      // Filter attendance to only validated + linked players
      let attendance = session.attendance;
      try {
        const voiceResult = await apiGet(`${serverUrl}/voice-members`, apiKey);
        if (voiceResult.status === 200 && voiceResult.body.members) {
          const linkedChars = new Set();
          for (const vm of voiceResult.body.members) {
            if (vm.character) linkedChars.add(vm.character.toLowerCase());
          }
          attendance = attendance.filter(a => a.validated && linkedChars.has(a.name.toLowerCase()));
        }
      } catch {}
```

Replace `session.attendance` with `attendance` in the merge/create API calls.

- [ ] **Step 3: Commit**

```bash
git add "Bacon Bot Distribution/web-app.js"
git commit -m "feat: filter uploads to validated+linked players only"
```

---

### Task 7: Update web-app.js attendance-update broadcast

**Files:**
- Modify: `Bacon Bot Distribution/web-app.js`

- [ ] **Step 1: Update the attendance-update SSE broadcast in POST /api/live/attendance**

Find the broadcast block in the attendance action handler. Update it to use the same deduped-by-name format with zones:

```javascript
      const playerMap = new Map();
      for (const [key, data] of liveWatcher.attendanceMap) {
        const name = data.name.toLowerCase();
        const existing = playerMap.get(name);
        if (!existing) {
          playerMap.set(name, {
            name: data.name,
            zones: [data.zone],
            lastSeen: data.lastSeen,
            exitTime: data.exitTime || null,
            validated: !!data.validated,
          });
        } else {
          if (data.zone && !existing.zones.includes(data.zone)) existing.zones.push(data.zone);
          if (data.lastSeen > existing.lastSeen) existing.lastSeen = data.lastSeen;
          if (data.validated) existing.validated = true;
          if (data.exitTime && (!existing.exitTime || data.exitTime > existing.exitTime)) existing.exitTime = data.exitTime;
        }
      }
      const allPlayersWithTime = Array.from(playerMap.values()).map(p => ({
        name: p.name,
        zones: p.zones,
        lastSeen: p.lastSeen.toISOString(),
        exitTime: p.exitTime ? p.exitTime.toISOString() : null,
        validated: p.validated,
      }));
```

- [ ] **Step 2: Commit**

```bash
git add "Bacon Bot Distribution/web-app.js"
git commit -m "feat: attendance-update SSE includes zones"
```

---

### Task 8: Frontend — display zones in attendance panel

**Files:**
- Modify: `Bacon Bot Distribution/public/app.js`

- [ ] **Step 1: Update renderSplitAttendance() to show zones**

In the linked attendance rendering, each player now has a `zones` array. Add the zone display after the discord tag:

```javascript
    const zoneTag = p.zones && p.zones.length > 0
      ? `<span class="attend-zones">${p.zones.join(', ')}</span>`
      : '';
```

Include `zoneTag` in the HTML output for each player row.

- [ ] **Step 2: Add CSS for zone display**

In `Bacon Bot Distribution/public/style.css`, add:

```css
.attend-zones {
  font-size: 10px;
  color: var(--text-dim);
  margin-left: 6px;
  flex-shrink: 0;
}
```

- [ ] **Step 3: Commit**

```bash
git add "Bacon Bot Distribution/public/app.js" "Bacon Bot Distribution/public/style.css"
git commit -m "feat: display zones in live attendance panel"
```

---

### Task 9: End Raid button

**Files:**
- Modify: `Bacon Bot Distribution/public/index.html`
- Modify: `Bacon Bot Distribution/public/app.js`
- Modify: `Bacon Bot Distribution/lib/log-watcher.js`
- Modify: `Bacon Bot Distribution/web-app.js`

- [ ] **Step 1: Add End Raid button to HTML**

In `index.html`, in the live mode controls bar, after the Upload Session button:

```html
<button id="btn-end-raid" class="btn-secondary hidden">End Raid</button>
```

- [ ] **Step 2: Add endRaid property to LogWatcher**

In `log-watcher.js`, add to the constructor:

```javascript
    this.raidEndTime = null;
```

Add a method:

```javascript
  setRaidEndTime() {
    this.raidEndTime = new Date();
    this.emit('raid-ended', { endTime: this.raidEndTime.toISOString() });
  }
```

Update `getSessionData()` to use `raidEndTime` if set:

```javascript
    const endTime = this.raidEndTime
      ? this.raidEndTime.toISOString()
      : lastSeen.toISOString();
```

Return `endTime` instead of `lastSeen` in the session data as the `lastSeen` field.

- [ ] **Step 3: Add API endpoint for ending raid**

In `web-app.js`, add before the `/api/live/stop` handler:

```javascript
    // ── POST /api/live/end-raid ────────────────────────────────────
    if (req.method === 'POST' && route === '/api/live/end-raid') {
      if (!liveWatcher) return json(400, { error: 'Live mode not running' });
      liveWatcher.setRaidEndTime();
      return json(200, { endTime: liveWatcher.raidEndTime.toISOString() });
    }
```

Wire up the SSE event:

```javascript
        liveWatcher.on('raid-ended', data => {
          liveClients.forEach(c => sseSend(c, 'raid-ended', data));
        });
```

- [ ] **Step 4: Add frontend handler**

In `app.js`, in `setupLive()`:

```javascript
  $('btn-end-raid').addEventListener('click', endRaid);
```

Show/hide the button when live mode starts/stops (next to upload button):

```javascript
  $('btn-end-raid').classList.remove('hidden');
```

In `cleanupLive()`:

```javascript
  $('btn-end-raid').classList.add('hidden');
```

Add the function:

```javascript
async function endRaid() {
  if (!confirm('Mark raid as ended? This sets the end timestamp.')) return;
  try {
    const res = await fetch('/api/live/end-raid', { method: 'POST' });
    if (res.ok) {
      const d = await res.json();
      const time = new Date(d.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('btn-end-raid').textContent = `Ended at ${time}`;
      $('btn-end-raid').disabled = true;
    }
  } catch {
    alert('Failed to end raid');
  }
}
```

Listen for the SSE event:

```javascript
  liveSource.addEventListener('raid-ended', e => {
    const d = JSON.parse(e.data);
    const time = new Date(d.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('btn-end-raid').textContent = `Ended at ${time}`;
    $('btn-end-raid').disabled = true;
  });
```

- [ ] **Step 5: Commit**

```bash
git add "Bacon Bot Distribution/public/index.html" "Bacon Bot Distribution/public/app.js" "Bacon Bot Distribution/lib/log-watcher.js" "Bacon Bot Distribution/web-app.js"
git commit -m "feat: add End Raid button to live mode"
```

---

### Task 10: Push and deploy

- [ ] **Step 1: Commit all remaining changes**

```bash
git add -A
git commit -m "feat: per-zone attendance, validated-only uploads, end raid button"
```

- [ ] **Step 2: Push to GitHub**

```bash
git push origin master
```

- [ ] **Step 3: Deploy to VM**

```bash
ssh -i ~/.ssh/id_ed25519 opc@129.146.138.160 "bash ~/bacon-bot/deploy/update.sh"
```

- [ ] **Step 4: Verify bot starts and commands work**

```bash
ssh -i ~/.ssh/id_ed25519 opc@129.146.138.160 "sudo journalctl -u bacon-bot -n 15 --no-pager"
```
