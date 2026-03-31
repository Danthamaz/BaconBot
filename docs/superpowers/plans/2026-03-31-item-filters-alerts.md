# Item Filters + Spell Alerts Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Import EQ item data from the Quarm SQL dump, provide an Item Filters UI for starring/trashing items, highlight valuable loot in the feed, and post Discord alerts for starred items.

**Architecture:** A SQL dump parser extracts zone and item data on startup into a local SQLite cache. The zone selector becomes a combo box. An Item Filters tab lets users search and star/trash items. Starred items trigger web app highlights and Discord channel alerts via a new bot API endpoint.

**Tech Stack:** Node.js, better-sqlite3, vanilla JS, MySQL dump parsing (regex-based)

---

### Task 1: SQL Dump Parser — Extract zones

**Files:**
- Create: `Bacon Bot Distribution/lib/quarm-db.js`

- [ ] **Step 1: Create the parser module with zone extraction**

Create `Bacon Bot Distribution/lib/quarm-db.js`:

```javascript
'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const CACHE_DB = path.join(__dirname, '..', 'quarm-cache.db');

function getDb() {
  const db = new Database(CACHE_DB);
  db.pragma('journal_mode = WAL');
  return db;
}

function initCache() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      short_name TEXT PRIMARY KEY,
      long_name  TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS zone_items (
      item_id    INTEGER NOT NULL,
      item_name  TEXT NOT NULL,
      zone_short TEXT NOT NULL,
      classes    INTEGER DEFAULT 0,
      price      INTEGER DEFAULT 0,
      nodrop     INTEGER DEFAULT 0,
      magic      INTEGER DEFAULT 0,
      PRIMARY KEY (item_id, zone_short)
    );
    CREATE INDEX IF NOT EXISTS idx_zone_items_zone ON zone_items(zone_short);
    CREATE INDEX IF NOT EXISTS idx_zone_items_name ON zone_items(item_name COLLATE NOCASE);
  `);
  db.close();
}

/**
 * Find the most recent quarm SQL dump in the given directory.
 */
function findDumpFile(dbPath) {
  const files = fs.readdirSync(dbPath).filter(f => f.startsWith('quarm_') && f.endsWith('.sql'));
  if (files.length === 0) return null;
  files.sort().reverse();
  return path.join(dbPath, files[0]);
}

/**
 * Parse zones from the SQL dump and insert into cache.
 */
function importZones(dumpPath) {
  const db = getDb();
  const content = fs.readFileSync(dumpPath, 'utf8');

  // Find the INSERT INTO `zone` VALUES block
  const zoneInsertRe = /INSERT INTO `zone` VALUES\s*\n?([\s\S]*?);\s*$/m;
  const match = content.match(zoneInsertRe);
  if (!match) { db.close(); return 0; }

  const insert = db.prepare('INSERT OR REPLACE INTO zones (short_name, long_name) VALUES (?, ?)');
  const tx = db.transaction((rows) => { for (const r of rows) insert.run(r[0], r[1]); });

  // Parse each row: ('short_name',id,'file','Long Name',...)
  const rowRe = /\('([^']*)',\d+,'[^']*','([^']*)'/g;
  const rows = [];
  let m;
  while ((m = rowRe.exec(match[1])) !== null) {
    rows.push([m[1], m[2]]);
  }

  tx(rows);
  db.close();
  return rows.length;
}

/**
 * Get all zone long_names sorted alphabetically.
 */
function getAllZones() {
  const db = getDb();
  const rows = db.prepare('SELECT short_name, long_name FROM zones ORDER BY long_name COLLATE NOCASE').all();
  db.close();
  return rows;
}

/**
 * Get the short_name for a long_name.
 */
function getZoneShortName(longName) {
  const db = getDb();
  const row = db.prepare('SELECT short_name FROM zones WHERE long_name = ? COLLATE NOCASE').get(longName);
  db.close();
  return row ? row.short_name : null;
}

module.exports = { initCache, findDumpFile, importZones, getAllZones, getZoneShortName, getDb, CACHE_DB };
```

- [ ] **Step 2: Commit**

```bash
git add "Bacon Bot Distribution/lib/quarm-db.js"
git commit -m "feat: quarm-db module with zone extraction from SQL dump"
```

---

### Task 2: SQL Dump Parser — Extract items per zone

**Files:**
- Modify: `Bacon Bot Distribution/lib/quarm-db.js`

- [ ] **Step 1: Add the item import function**

This follows the chain: zone → spawn2 → spawnentry → npc_types → loottable_entries → lootdrop_entries → items. Since the SQL dump is large (75MB), parse each table's INSERT block separately and build lookup maps in memory.

Add to `quarm-db.js`:

```javascript
/**
 * Parse a specific table's INSERT VALUES from the dump.
 * Returns an array of arrays (each inner array is one row's values).
 * Only extracts specified column indices for efficiency.
 */
function parseTable(dumpPath, tableName, colIndices) {
  const content = fs.readFileSync(dumpPath, 'utf8');
  const re = new RegExp(`INSERT INTO \`${tableName}\` VALUES\\s*\\n?([\\s\\S]*?);\\s*$`, 'gm');
  const results = [];

  let blockMatch;
  while ((blockMatch = re.exec(content)) !== null) {
    const block = blockMatch[1];
    // Parse row by row — each row is (...),
    let depth = 0;
    let inQuote = false;
    let escaped = false;
    let rowStart = -1;
    let fieldStart = -1;
    let fieldIdx = 0;
    let row = [];

    for (let i = 0; i < block.length; i++) {
      const ch = block[i];
      if (escaped) { escaped = false; continue; }
      if (ch === '\\') { escaped = true; continue; }
      if (ch === "'" && depth > 0) { inQuote = !inQuote; continue; }
      if (inQuote) continue;

      if (ch === '(') {
        depth++;
        if (depth === 1) { rowStart = i + 1; fieldStart = i + 1; fieldIdx = 0; row = []; }
      } else if (ch === ')' && depth === 1) {
        depth = 0;
        if (colIndices.includes(fieldIdx)) {
          row.push(extractField(block, fieldStart, i));
        }
        if (row.length > 0) results.push(row);
      } else if (ch === ',' && depth === 1) {
        if (colIndices.includes(fieldIdx)) {
          row.push(extractField(block, fieldStart, i));
        }
        fieldIdx++;
        fieldStart = i + 1;
      }
    }
  }

  return results;
}

function extractField(str, start, end) {
  let val = str.slice(start, end).trim();
  if (val === 'NULL') return null;
  if (val.startsWith("'") && val.endsWith("'")) return val.slice(1, -1).replace(/\\'/g, "'");
  return val;
}

/**
 * Import items for the given zone short_names.
 * Follows: spawn2 → spawnentry → npc_types → loottable_entries → lootdrop_entries → items
 */
function importItemsForZones(dumpPath, zoneShortNames) {
  const db = getDb();
  db.exec('DELETE FROM zone_items');

  const zoneSet = new Set(zoneShortNames.map(z => z.toLowerCase()));

  // 1. spawn2: zone(col 2) → spawngroupID(col 1)
  console.log('[quarm-db] Parsing spawn2...');
  const spawn2Rows = parseTable(dumpPath, 'spawn2', [1, 2]);
  const spawnGroupsInZone = new Set();
  for (const [sgId, zone] of spawn2Rows) {
    if (zoneSet.has((zone || '').toLowerCase())) spawnGroupsInZone.add(sgId);
  }

  // 2. spawnentry: spawngroupID(col 0) → npcID(col 1)
  console.log('[quarm-db] Parsing spawnentry...');
  const spawnentryRows = parseTable(dumpPath, 'spawnentry', [0, 1]);
  const npcIds = new Set();
  for (const [sgId, npcId] of spawnentryRows) {
    if (spawnGroupsInZone.has(sgId)) npcIds.add(npcId);
  }

  // 3. npc_types: id(col 0) → loottable_id(col 15)
  console.log('[quarm-db] Parsing npc_types...');
  const npcRows = parseTable(dumpPath, 'npc_types', [0, 15]);
  const loottableIds = new Set();
  for (const [id, ltId] of npcRows) {
    if (npcIds.has(id) && ltId && ltId !== '0') loottableIds.add(ltId);
  }

  // 4. loottable_entries: loottable_id(col 0) → lootdrop_id(col 1)
  console.log('[quarm-db] Parsing loottable_entries...');
  const ltRows = parseTable(dumpPath, 'loottable_entries', [0, 1]);
  const lootdropIds = new Set();
  for (const [ltId, ldId] of ltRows) {
    if (loottableIds.has(ltId)) lootdropIds.add(ldId);
  }

  // 5. lootdrop_entries: lootdrop_id(col 0) → item_id(col 1)
  console.log('[quarm-db] Parsing lootdrop_entries...');
  const ldRows = parseTable(dumpPath, 'lootdrop_entries', [0, 1]);
  const itemIds = new Set();
  for (const [ldId, itemId] of ldRows) {
    if (lootdropIds.has(ldId)) itemIds.add(itemId);
  }

  // 6. items: id(col 0), Name(col 2), classes(col 23), price(col 25), nodrop(col 62), magic(col 57)
  console.log('[quarm-db] Parsing items...');
  const itemRows = parseTable(dumpPath, 'items', [0, 2, 23, 25, 62, 57]);
  const itemMap = new Map();
  for (const [id, name, classes, price, nodrop, magic] of itemRows) {
    if (itemIds.has(id)) {
      itemMap.set(id, { id: parseInt(id), name, classes: parseInt(classes) || 0, price: parseInt(price) || 0, nodrop: parseInt(nodrop) || 0, magic: parseInt(magic) || 0 });
    }
  }

  // Map items back to zones through the chain
  // Rebuild: item_id → lootdrop_id → loottable_id → npc_id → spawngroup → zone
  const ldToItems = new Map();
  for (const [ldId, itemId] of ldRows) {
    if (!ldToItems.has(ldId)) ldToItems.set(ldId, []);
    ldToItems.get(ldId).push(itemId);
  }
  const ltToLd = new Map();
  for (const [ltId, ldId] of ltRows) {
    if (!ltToLd.has(ltId)) ltToLd.set(ltId, []);
    ltToLd.get(ltId).push(ldId);
  }
  const npcToLt = new Map();
  for (const [id, ltId] of npcRows) {
    if (ltId && ltId !== '0') npcToLt.set(id, ltId);
  }
  const sgToNpcs = new Map();
  for (const [sgId, npcId] of spawnentryRows) {
    if (!sgToNpcs.has(sgId)) sgToNpcs.set(sgId, []);
    sgToNpcs.get(sgId).push(npcId);
  }

  // Build zone → item_id mapping
  const insert = db.prepare('INSERT OR IGNORE INTO zone_items (item_id, item_name, zone_short, classes, price, nodrop, magic) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const tx = db.transaction(() => {
    for (const [sgId, zone] of spawn2Rows) {
      const zLower = (zone || '').toLowerCase();
      if (!zoneSet.has(zLower)) continue;
      const npcs = sgToNpcs.get(sgId) || [];
      for (const npcId of npcs) {
        const ltId = npcToLt.get(npcId);
        if (!ltId) continue;
        const ldIds = ltToLd.get(ltId) || [];
        for (const ldId of ldIds) {
          const iIds = ldToItems.get(ldId) || [];
          for (const iId of iIds) {
            const item = itemMap.get(iId);
            if (item) {
              insert.run(item.id, item.name, zone.toLowerCase(), item.classes, item.price, item.nodrop, item.magic);
            }
          }
        }
      }
    }
  });
  tx();

  const count = db.prepare('SELECT COUNT(DISTINCT item_id) AS cnt FROM zone_items').get().cnt;
  db.close();
  console.log(`[quarm-db] Imported ${count} unique items for ${zoneShortNames.length} zones`);
  return count;
}

/**
 * Search items in approved zones by name (partial match).
 */
function searchItems(query, limit = 50) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT DISTINCT item_id, item_name, classes, price, nodrop, magic
    FROM zone_items
    WHERE item_name LIKE ? COLLATE NOCASE
    ORDER BY item_name COLLATE NOCASE
    LIMIT ?
  `).all(`%${query}%`, limit);
  db.close();
  return rows;
}
```

Add `importItemsForZones` and `searchItems` to the module.exports.

- [ ] **Step 2: Commit**

```bash
git add "Bacon Bot Distribution/lib/quarm-db.js"
git commit -m "feat: import zone items from quarm SQL dump"
```

---

### Task 3: Web app server — startup import and API endpoints

**Files:**
- Modify: `Bacon Bot Distribution/web-app.js`

- [ ] **Step 1: Add eqDbPath to DEFAULT_CONFIG and startup import**

At the top of `web-app.js`, require the quarm-db module and trigger import on startup:

```javascript
const quarmDb = require('./lib/quarm-db');
```

Add to DEFAULT_CONFIG:

```javascript
  eqDbPath: '',
  starredItems: [],
```

After the server starts (`server.listen`), add:

```javascript
  // Import quarm data on startup
  const cfg = loadConfig();
  if (cfg.eqDbPath) {
    try {
      quarmDb.initCache();
      const dumpFile = quarmDb.findDumpFile(cfg.eqDbPath);
      if (dumpFile) {
        console.log(`[quarm-db] Importing from ${dumpFile}...`);
        quarmDb.importZones(dumpFile);
        if (cfg.approvedZones && cfg.approvedZones.length > 0) {
          const shortNames = cfg.approvedZones.map(z => quarmDb.getZoneShortName(z)).filter(Boolean);
          if (shortNames.length > 0) quarmDb.importItemsForZones(dumpFile, shortNames);
        }
        console.log('[quarm-db] Import complete');
      }
    } catch (err) {
      console.error('[quarm-db] Import failed:', err.message);
    }
  }
```

- [ ] **Step 2: Add API endpoints**

Add these endpoints in the request handler:

```javascript
    // ── GET /api/zones ────────────────────────────────────────────
    if (req.method === 'GET' && route === '/api/zones') {
      try {
        quarmDb.initCache();
        return json(200, quarmDb.getAllZones());
      } catch (err) {
        return json(500, { error: err.message });
      }
    }

    // ── GET /api/items?q=search ───────────────────────────────────
    if (req.method === 'GET' && route === '/api/items') {
      const q = url.searchParams.get('q') || '';
      if (q.length < 2) return json(200, []);
      try {
        return json(200, quarmDb.searchItems(q));
      } catch (err) {
        return json(500, { error: err.message });
      }
    }

    // ── POST /api/star-item ───────────────────────────────────────
    if (req.method === 'POST' && route === '/api/star-item') {
      const body = JSON.parse(await readBody(req));
      const { itemName, starred } = body;
      if (!itemName) return json(400, { error: 'itemName required' });
      const cfg = loadConfig();
      if (!cfg.starredItems) cfg.starredItems = [];
      const lower = itemName.toLowerCase();
      if (starred) {
        if (!cfg.starredItems.some(i => i.toLowerCase() === lower)) cfg.starredItems.push(itemName);
      } else {
        cfg.starredItems = cfg.starredItems.filter(i => i.toLowerCase() !== lower);
      }
      saveConfig(cfg);
      return json(200, { starredItems: cfg.starredItems });
    }

    // ── POST /api/rebuild-items ───────────────────────────────────
    if (req.method === 'POST' && route === '/api/rebuild-items') {
      const cfg = loadConfig();
      if (!cfg.eqDbPath) return json(400, { error: 'eqDbPath not configured' });
      try {
        const dumpFile = quarmDb.findDumpFile(cfg.eqDbPath);
        if (!dumpFile) return json(404, { error: 'No SQL dump found' });
        quarmDb.initCache();
        const shortNames = (cfg.approvedZones || []).map(z => quarmDb.getZoneShortName(z)).filter(Boolean);
        const count = quarmDb.importItemsForZones(dumpFile, shortNames);
        return json(200, { count });
      } catch (err) {
        return json(500, { error: err.message });
      }
    }
```

- [ ] **Step 3: Trigger item rebuild when approved zones are saved**

In the `POST /api/config` handler, after `saveConfig(cfg)`, add:

```javascript
      // Rebuild item cache if zones changed
      if (body.approvedZones !== undefined && cfg.eqDbPath) {
        try {
          const dumpFile = quarmDb.findDumpFile(cfg.eqDbPath);
          if (dumpFile) {
            quarmDb.initCache();
            const shortNames = (cfg.approvedZones || []).map(z => quarmDb.getZoneShortName(z)).filter(Boolean);
            if (shortNames.length > 0) quarmDb.importItemsForZones(dumpFile, shortNames);
          }
        } catch (err) {
          console.error('[quarm-db] Rebuild failed:', err.message);
        }
      }
```

- [ ] **Step 4: Commit**

```bash
git add "Bacon Bot Distribution/web-app.js"
git commit -m "feat: web app serves zone list, item search, star/trash API"
```

---

### Task 4: Zone combo box in Settings

**Files:**
- Modify: `Bacon Bot Distribution/public/index.html`
- Modify: `Bacon Bot Distribution/public/app.js`
- Modify: `Bacon Bot Distribution/public/style.css`

- [ ] **Step 1: Replace textarea with combo box HTML**

In `index.html`, replace the approved zones textarea section:

```html
        <div class="form-group">
          <label for="cfg-zones">Approved Zones</label>
          <div class="zone-combo" id="zone-combo">
            <div class="zone-tags" id="zone-tags"></div>
            <input type="text" id="cfg-zone-search" placeholder="Type to search zones..." autocomplete="off">
            <div class="zone-dropdown hidden" id="zone-dropdown"></div>
          </div>
        </div>
```

- [ ] **Step 2: Add combo box CSS**

```css
.zone-combo {
  position: relative;
}

.zone-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-bottom: 6px;
}

.zone-tag {
  background: var(--bg-input);
  border: 1px solid var(--border);
  border-radius: 3px;
  padding: 2px 8px;
  font-size: 12px;
  display: flex;
  align-items: center;
  gap: 4px;
}

.zone-tag .zone-tag-remove {
  cursor: pointer;
  color: var(--text-dim);
  font-size: 10px;
}
.zone-tag .zone-tag-remove:hover { color: var(--red); }

.zone-dropdown {
  position: absolute;
  top: 100%;
  left: 0;
  right: 0;
  max-height: 200px;
  overflow-y: auto;
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 4px;
  z-index: 10;
}

.zone-dropdown-item {
  padding: 6px 12px;
  font-size: 12px;
  cursor: pointer;
}
.zone-dropdown-item:hover { background: rgba(255,255,255,0.05); }
```

- [ ] **Step 3: Add combo box JS**

In `app.js`, add zone combo functionality:

```javascript
let allZones = [];

async function loadZoneList() {
  try {
    const res = await fetch('/api/zones');
    if (res.ok) allZones = await res.json();
  } catch {}
}

function renderZoneTags() {
  const tags = (config.approvedZones || []).slice().sort((a, b) => a.localeCompare(b));
  $('zone-tags').innerHTML = tags.map(z =>
    `<span class="zone-tag">${z}<span class="zone-tag-remove" onclick="removeZone('${z.replace(/'/g, "\\'")}')">&times;</span></span>`
  ).join('');
}

window.removeZone = function(zoneName) {
  config.approvedZones = (config.approvedZones || []).filter(z => z !== zoneName);
  renderZoneTags();
};

function setupZoneCombo() {
  const input = $('cfg-zone-search');
  const dropdown = $('zone-dropdown');

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    if (q.length < 1) { dropdown.classList.add('hidden'); return; }
    const selected = new Set((config.approvedZones || []).map(z => z.toLowerCase()));
    const matches = allZones.filter(z =>
      z.long_name.toLowerCase().includes(q) && !selected.has(z.long_name.toLowerCase())
    ).slice(0, 20);
    if (matches.length === 0) { dropdown.classList.add('hidden'); return; }
    dropdown.innerHTML = matches.map(z =>
      `<div class="zone-dropdown-item" onclick="addZone('${z.long_name.replace(/'/g, "\\'")}')">${z.long_name}</div>`
    ).join('');
    dropdown.classList.remove('hidden');
  });

  input.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.add('hidden'), 200);
  });
}

window.addZone = function(zoneName) {
  if (!config.approvedZones) config.approvedZones = [];
  if (!config.approvedZones.includes(zoneName)) config.approvedZones.push(zoneName);
  renderZoneTags();
  $('cfg-zone-search').value = '';
  $('zone-dropdown').classList.add('hidden');
};
```

Update `loadConfig()` to call `loadZoneList()`, `setupZoneCombo()`, and `renderZoneTags()`. Update `saveSettings()` to read from the tags instead of a textarea.

- [ ] **Step 4: Commit**

```bash
git add "Bacon Bot Distribution/public/index.html" "Bacon Bot Distribution/public/app.js" "Bacon Bot Distribution/public/style.css"
git commit -m "feat: zone combo box with type-to-filter and tags"
```

---

### Task 5: Item Filters tab

**Files:**
- Modify: `Bacon Bot Distribution/public/index.html`
- Modify: `Bacon Bot Distribution/public/app.js`
- Modify: `Bacon Bot Distribution/public/style.css`

- [ ] **Step 1: Add Item Filters tab and section in HTML**

Add tab button in nav:

```html
<button class="tab" data-view="items">Item Filters</button>
```

Add section:

```html
    <!-- ═══ Item Filters View ═══ -->
    <section id="view-items" class="view hidden">
      <div class="controls">
        <input type="text" id="item-search" placeholder="Search items..." style="flex:1">
      </div>
      <div id="item-results" class="item-results"></div>
    </section>
```

- [ ] **Step 2: Add item search JS**

```javascript
let searchTimeout = null;

function setupItemFilters() {
  $('item-search').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(doItemSearch, 300);
  });
}

async function doItemSearch() {
  const q = $('item-search').value.trim();
  if (q.length < 2) { $('item-results').innerHTML = ''; return; }

  try {
    const res = await fetch(`/api/items?q=${encodeURIComponent(q)}`);
    if (!res.ok) return;
    const items = await res.json();
    const starred = new Set((config.starredItems || []).map(i => i.toLowerCase()));
    const ignored = new Set((config.ignoredItems || []).map(i => i.toLowerCase()));

    $('item-results').innerHTML = items.map(item => {
      const isStarred = starred.has(item.item_name.toLowerCase());
      const isTrashed = ignored.has(item.item_name.toLowerCase());
      const starClass = isStarred ? ' active' : '';
      const trashClass = isTrashed ? ' active' : '';
      return `<div class="item-row">
        <span class="item-name">${item.item_name}</span>
        <span class="item-actions">
          <span class="item-star${starClass}" title="Mark valuable" onclick="toggleStarItem('${item.item_name.replace(/'/g, "\\'")}')">&#9733;</span>
          <span class="item-trash${trashClass}" title="Ignore item" onclick="toggleTrashItem('${item.item_name.replace(/'/g, "\\'")}')">&#128465;</span>
        </span>
      </div>`;
    }).join('');
  } catch {}
}

window.toggleStarItem = async function(itemName) {
  const starred = (config.starredItems || []).map(i => i.toLowerCase());
  const isStarred = starred.includes(itemName.toLowerCase());
  try {
    const res = await fetch('/api/star-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemName, starred: !isStarred }),
    });
    if (res.ok) {
      const data = await res.json();
      config.starredItems = data.starredItems;
      doItemSearch();
    }
  } catch {}
};

window.toggleTrashItem = async function(itemName) {
  const ignored = (config.ignoredItems || []).map(i => i.toLowerCase());
  const isIgnored = ignored.includes(itemName.toLowerCase());
  if (isIgnored) {
    config.ignoredItems = config.ignoredItems.filter(i => i.toLowerCase() !== itemName.toLowerCase());
  } else {
    if (!config.ignoredItems) config.ignoredItems = [];
    config.ignoredItems.push(itemName);
  }
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignoredItems: config.ignoredItems }),
    });
    doItemSearch();
  } catch {}
};
```

Call `setupItemFilters()` from DOMContentLoaded.

- [ ] **Step 3: Add item filter CSS**

```css
.item-results {
  max-height: 500px;
  overflow-y: auto;
}

.item-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 6px 12px;
  border-bottom: 1px solid rgba(255,255,255,0.05);
  font-size: 13px;
}
.item-row:hover { background: rgba(255,255,255,0.03); }

.item-name { flex: 1; }

.item-actions { display: flex; gap: 8px; }

.item-star, .item-trash {
  cursor: pointer;
  font-size: 16px;
  color: var(--text-dim);
  transition: color 0.15s;
}
.item-star:hover, .item-star.active { color: var(--amber); }
.item-trash:hover, .item-trash.active { color: var(--red); }
```

- [ ] **Step 4: Commit**

```bash
git add "Bacon Bot Distribution/public/index.html" "Bacon Bot Distribution/public/app.js" "Bacon Bot Distribution/public/style.css"
git commit -m "feat: Item Filters tab with search, star, and trash"
```

---

### Task 6: Loot feed highlight for starred items

**Files:**
- Modify: `Bacon Bot Distribution/public/app.js`
- Modify: `Bacon Bot Distribution/public/style.css`
- Modify: `Bacon Bot Distribution/lib/log-watcher.js`

- [ ] **Step 1: Check starred items in loot feed rendering**

In `app.js`, in the SSE `loot` event listener, after checking ignored items and before rendering, check if the item is starred:

```javascript
    const isStarred = (config.starredItems || []).some(s => s.toLowerCase() === d.itemName.toLowerCase());
```

Add a class to the loot entry if starred:

```javascript
    if (isStarred) div.classList.add('loot-starred');
```

- [ ] **Step 2: Add starred loot CSS**

```css
.loot-starred {
  background: rgba(255,171,0,0.1);
  border-left: 3px solid var(--amber);
  padding-left: 8px;
}
```

- [ ] **Step 3: Emit starred-loot event from LogWatcher**

In `log-watcher.js`, add `starredItems` to the constructor (similar to `ignoredItems`):

```javascript
    this.starredItems = new Set((starredItems || []).map(i => i.toLowerCase()));
```

Add a method:

```javascript
  setStarredItems(items) {
    this.starredItems = new Set((items || []).map(i => i.toLowerCase()));
  }

  _isStarredItem(itemName) {
    return this.starredItems.has(itemName.toLowerCase());
  }
```

In the loot emission sections (self-loot and other-loot), after emitting the normal `loot` event, check and emit starred:

```javascript
      if (this._isStarredItem(lootItem.itemName)) {
        this.emit('starred-loot', { ...lootItem, timestamp: utcTs.toISOString() });
      }
```

- [ ] **Step 4: Commit**

```bash
git add "Bacon Bot Distribution/public/app.js" "Bacon Bot Distribution/public/style.css" "Bacon Bot Distribution/lib/log-watcher.js"
git commit -m "feat: highlight starred items in loot feed"
```

---

### Task 7: Discord alerts for starred items

**Files:**
- Modify: `lib/api-server.js`
- Modify: `Bacon Bot Distribution/web-app.js`

- [ ] **Step 1: Add POST /alert endpoint to the bot API**

In `lib/api-server.js`, before the 404 catch-all, add:

```javascript
    // POST /alert — send an alert to the alert channel
    if (req.method === 'POST' && req.url === '/alert') {
      const alertChannelId = process.env.ALERT_CHANNEL_ID;
      if (!alertChannelId || !_client) {
        return send(res, 503, { error: 'Alert channel not configured' });
      }
      try {
        const { itemName, playerName, zone, timestamp } = JSON.parse(await readBody(req));
        const guild = _client.guilds.cache.first();
        if (!guild) return send(res, 503, { error: 'No guild available' });
        const channel = guild.channels.cache.get(alertChannelId);
        if (!channel) return send(res, 503, { error: 'Alert channel not found' });

        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
          .setTitle('⭐ Valuable Item Looted')
          .setColor(0xFFAB00)
          .addFields(
            { name: 'Item', value: itemName || 'Unknown', inline: true },
            { name: 'Looted By', value: playerName || 'Unknown', inline: true },
            { name: 'Zone', value: zone || 'Unknown', inline: true },
          )
          .setTimestamp(timestamp ? new Date(timestamp) : new Date());

        await channel.send({ embeds: [embed] });
        return send(res, 200, { ok: true });
      } catch (err) {
        console.error('[API] /alert error:', err.message);
        return send(res, 500, { error: err.message });
      }
    }
```

- [ ] **Step 2: Wire up starred-loot event in web-app.js**

In the liveWatcher event wiring section, add:

```javascript
        liveWatcher.on('starred-loot', async data => {
          // Post alert to Discord
          try {
            await apiPost(`${serverUrl}/alert`, {
              itemName: data.itemName,
              playerName: data.playerName,
              zone: data.zone,
              timestamp: data.timestamp,
            }, apiKey);
          } catch (err) {
            console.error('[alert] Failed to post Discord alert:', err.message);
          }
          liveClients.forEach(c => sseSend(c, 'starred-loot', data));
        });
```

Pass `cfg.starredItems` when creating the LogWatcher:

```javascript
        liveWatcher = new LogWatcher({
          filePath: file, timezone, characterName: character || null,
          approvedZones: cfg.approvedZones,
          raidDays:      cfg.raidDays,
          raidStartUTC:  cfg.raidStartUTC,
          raidEndUTC:    cfg.raidEndUTC,
          ignoredItems:  cfg.ignoredItems,
          starredItems:  cfg.starredItems,
        });
```

Also update the `POST /api/star-item` endpoint to update the live watcher's starred list:

```javascript
      if (liveWatcher) liveWatcher.setStarredItems(cfg.starredItems);
```

- [ ] **Step 3: Commit**

```bash
git add lib/api-server.js "Bacon Bot Distribution/web-app.js"
git commit -m "feat: Discord alerts for starred loot items"
```

---

### Task 8: Settings — eqDbPath config field

**Files:**
- Modify: `Bacon Bot Distribution/public/index.html`
- Modify: `Bacon Bot Distribution/public/app.js`

- [ ] **Step 1: Add EQ Database Path field to Settings**

In `index.html`, add before the approved zones section:

```html
        <div class="form-group">
          <label for="cfg-eqdbpath">EQ Database Path <span class="hint">(folder containing quarm_*.sql)</span></label>
          <input type="text" id="cfg-eqdbpath" placeholder="e.g. C:\Apps\quarm\db">
        </div>
```

- [ ] **Step 2: Wire up in app.js**

In `loadConfig()`:

```javascript
    $('cfg-eqdbpath').value = config.eqDbPath || '';
```

In `saveSettings()`:

```javascript
  config.eqDbPath = $('cfg-eqdbpath').value.trim();
```

- [ ] **Step 3: Commit**

```bash
git add "Bacon Bot Distribution/public/index.html" "Bacon Bot Distribution/public/app.js"
git commit -m "feat: eqDbPath settings field"
```

---

### Task 9: Deploy

- [ ] **Step 1: Commit any remaining changes, push, and deploy**

```bash
git add -A
git push origin master
ssh -i ~/.ssh/id_ed25519 opc@129.146.138.160 "bash ~/bacon-bot/deploy/update.sh"
```
