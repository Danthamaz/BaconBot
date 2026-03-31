/**
 * Quarm Database Parser
 *
 * Extracts zone and item data from the EQ server's MySQL dump file.
 * Follows the loot chain: zone -> spawn2 -> spawnentry -> npc_types ->
 * loottable_entries -> lootdrop_entries -> items
 *
 * Caches results in a local SQLite database for fast lookups.
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const CACHE_DB = path.join(__dirname, '..', 'quarm-cache.db');

let _db = null;

// ---------------------------------------------------------------------------
// Database helpers
// ---------------------------------------------------------------------------

function getDb() {
  if (!_db) {
    _db = new Database(CACHE_DB);
    _db.pragma('journal_mode = WAL');
  }
  return _db;
}

/**
 * Create the cache SQLite DB with zones and zone_items tables.
 */
function initCache() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS zones (
      short_name TEXT PRIMARY KEY,
      long_name  TEXT
    );

    CREATE TABLE IF NOT EXISTS zone_items (
      item_id    INTEGER,
      item_name  TEXT,
      zone_short TEXT,
      classes    INTEGER,
      price      INTEGER,
      nodrop     INTEGER,
      magic      INTEGER,
      PRIMARY KEY (item_id, zone_short)
    );
  `);
  console.log('[quarm-db] Cache database initialized.');
}

// ---------------------------------------------------------------------------
// Dump file discovery
// ---------------------------------------------------------------------------

/**
 * Find the most recent quarm_*.sql file in the given directory.
 * @param {string} dbPath - Directory to search in
 * @returns {string|null} Full path to the dump file, or null if not found
 */
function findDumpFile(dbPath) {
  if (!fs.existsSync(dbPath)) {
    console.log(`[quarm-db] Directory not found: ${dbPath}`);
    return null;
  }

  const files = fs.readdirSync(dbPath)
    .filter(f => /^quarm_.*\.sql$/.test(f))
    .sort()
    .reverse(); // most recent first (lexicographic sort on timestamp in filename)

  if (files.length === 0) {
    console.log('[quarm-db] No quarm_*.sql files found.');
    return null;
  }

  const chosen = path.join(dbPath, files[0]);
  console.log(`[quarm-db] Found dump file: ${chosen}`);
  return chosen;
}

// ---------------------------------------------------------------------------
// SQL row parser
// ---------------------------------------------------------------------------

/**
 * Parse a single SQL VALUES tuple, extracting only the needed column indices.
 *
 * Handles:
 *  - Single-quoted strings with \' and \\ escapes
 *  - NULL values
 *  - Numeric values (integers and floats, including negatives)
 *
 * @param {string} content - The full file content
 * @param {number} startIdx - Index of the opening '(' in content
 * @param {number[]} neededCols - Sorted array of 0-based column indices to extract
 * @returns {{ values: Map<number, any>, endIdx: number }}
 *          values maps column-index -> parsed value; endIdx is past the closing ')'
 */
function parseRow(content, startIdx, neededCols) {
  const values = new Map();
  let i = startIdx + 1; // skip '('
  let colIdx = 0;
  const maxCol = neededCols[neededCols.length - 1];
  const neededSet = new Set(neededCols);

  while (i < content.length) {
    const ch = content[i];

    // End of tuple
    if (ch === ')') {
      return { values, endIdx: i + 1 };
    }

    // Skip whitespace and commas between values
    if (ch === ',' || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    // Parse value at current column
    const need = neededSet.has(colIdx);
    let val = null;

    if (ch === '\'') {
      // Quoted string
      i++; // skip opening quote
      if (need) {
        let str = '';
        while (i < content.length) {
          const c = content[i];
          if (c === '\\') {
            i++;
            if (i < content.length) {
              str += content[i];
            }
            i++;
          } else if (c === '\'') {
            i++;
            break;
          } else {
            str += c;
            i++;
          }
        }
        val = str;
      } else {
        // Skip string content without building it
        while (i < content.length) {
          if (content[i] === '\\') { i += 2; continue; }
          if (content[i] === '\'') { i++; break; }
          i++;
        }
      }
    } else if (content[i] === 'N' && content.substring(i, i + 4) === 'NULL') {
      val = null;
      i += 4;
    } else {
      // Numeric value (or other unquoted value)
      let numStr = '';
      while (i < content.length) {
        const c = content[i];
        if (c === ',' || c === ')') break;
        numStr += c;
        i++;
      }
      if (need) {
        const num = Number(numStr);
        val = isNaN(num) ? numStr.trim() : num;
      }
    }

    if (need) {
      values.set(colIdx, val);
    }

    colIdx++;

    // Optimization: if we've passed the last needed column, skip to end of tuple
    if (colIdx > maxCol) {
      // Fast-forward to closing ')' — need to handle quoted strings
      while (i < content.length) {
        const c = content[i];
        if (c === '\'') {
          i++;
          while (i < content.length) {
            if (content[i] === '\\') { i += 2; continue; }
            if (content[i] === '\'') { i++; break; }
            i++;
          }
          continue;
        }
        if (c === ')') {
          return { values, endIdx: i + 1 };
        }
        i++;
      }
    }
  }

  return { values, endIdx: i };
}

/**
 * Parse all INSERT INTO `tableName` VALUES blocks from the dump content.
 * Calls rowCallback(values) for each row, where values is a Map of col->value.
 *
 * @param {string} content - Full file content
 * @param {string} tableName - Table name to look for
 * @param {number[]} neededCols - Column indices to extract (sorted)
 * @param {function} rowCallback - Called with (valuesMap) for each row
 */
function parseTable(content, tableName, neededCols, rowCallback) {
  const marker = 'INSERT INTO `' + tableName + '` VALUES';
  let searchFrom = 0;

  while (true) {
    const blockStart = content.indexOf(marker, searchFrom);
    if (blockStart === -1) break;

    let i = blockStart + marker.length;

    // Skip whitespace after VALUES
    while (i < content.length && (content[i] === ' ' || content[i] === '\n' || content[i] === '\r')) {
      i++;
    }

    // Parse rows until we hit a semicolon
    while (i < content.length) {
      // Skip whitespace and commas between rows
      while (i < content.length && (content[i] === ',' || content[i] === '\n' || content[i] === '\r' || content[i] === ' ')) {
        i++;
      }

      if (content[i] === ';' || content[i] === undefined) break;

      if (content[i] === '(') {
        const result = parseRow(content, i, neededCols);
        rowCallback(result.values);
        i = result.endIdx;
      } else {
        // Unexpected char, move past it
        i++;
      }
    }

    searchFrom = i;
  }
}

// ---------------------------------------------------------------------------
// Import functions
// ---------------------------------------------------------------------------

/**
 * Parse the zone table and insert into the cache DB.
 * zone columns: short_name (0), long_name (3)
 *
 * @param {string} dumpPath - Path to the SQL dump file
 */
function importZones(dumpPath) {
  console.log('[quarm-db] Parsing zone table...');
  const content = fs.readFileSync(dumpPath, 'utf8');
  const db = getDb();

  const insert = db.prepare('INSERT OR REPLACE INTO zones (short_name, long_name) VALUES (?, ?)');
  const insertMany = db.transaction((rows) => {
    for (const row of rows) {
      insert.run(row.short, row.long);
    }
  });

  const rows = [];
  parseTable(content, 'zone', [0, 3], (vals) => {
    const shortName = vals.get(0);
    const longName = vals.get(3);
    if (shortName && longName) {
      rows.push({ short: shortName, long: longName });
    }
  });

  insertMany(rows);
  console.log(`[quarm-db] Imported ${rows.length} zones.`);
}

/**
 * Follow the loot chain to find items that drop in specific zones, then
 * insert matching items into the zone_items cache table.
 *
 * Chain: zone -> spawn2 -> spawnentry -> npc_types -> loottable_entries
 *        -> lootdrop_entries -> items
 *
 * @param {string} dumpPath - Path to the SQL dump file
 * @param {string[]} zoneShortNames - Array of zone short_names to import items for
 */
function importItemsForZones(dumpPath, zoneShortNames) {
  console.log(`[quarm-db] Importing items for ${zoneShortNames.length} zones...`);
  const content = fs.readFileSync(dumpPath, 'utf8');
  const db = getDb();

  // Normalize zone names to lowercase for case-insensitive matching
  const zoneSet = new Set(zoneShortNames.map(z => z.toLowerCase()));

  // Step 1: Parse spawn2 — build zone -> Set<spawngroupID> mapping
  // spawn2 columns: spawngroupID (1), zone (2)
  console.log('[quarm-db] Parsing spawn2...');
  const zoneToSpawngroups = new Map(); // zone_short_lower -> Set<spawngroupID>
  const allSpawngroupIds = new Set();
  parseTable(content, 'spawn2', [1, 2], (vals) => {
    const zone = vals.get(2);
    if (zone && zoneSet.has(zone.toString().toLowerCase())) {
      const zLower = zone.toString().toLowerCase();
      if (!zoneToSpawngroups.has(zLower)) {
        zoneToSpawngroups.set(zLower, new Set());
      }
      const sgId = vals.get(1);
      zoneToSpawngroups.get(zLower).add(sgId);
      allSpawngroupIds.add(sgId);
    }
  });
  console.log(`[quarm-db]   Found ${allSpawngroupIds.size} spawn groups in target zones.`);

  // Step 2: Parse spawnentry — build spawngroup -> Set<npcID> mapping
  // spawnentry columns: spawngroupID (0), npcID (1)
  console.log('[quarm-db] Parsing spawnentry...');
  const sgToNpcs = new Map(); // spawngroupID -> Set<npcID>
  const allNpcIds = new Set();
  parseTable(content, 'spawnentry', [0, 1], (vals) => {
    const sg = vals.get(0);
    if (allSpawngroupIds.has(sg)) {
      const npcId = vals.get(1);
      if (!sgToNpcs.has(sg)) sgToNpcs.set(sg, new Set());
      sgToNpcs.get(sg).add(npcId);
      allNpcIds.add(npcId);
    }
  });
  console.log(`[quarm-db]   Found ${allNpcIds.size} NPCs in target zones.`);

  // Step 3: Parse npc_types — build npc -> Set<loottableID> mapping
  // npc_types columns: id (0), loottable_id (15)
  console.log('[quarm-db] Parsing npc_types...');
  const npcToLt = new Map(); // npcID -> Set<loottableID>
  const allLoottableIds = new Set();
  parseTable(content, 'npc_types', [0, 15], (vals) => {
    const npcId = vals.get(0);
    if (allNpcIds.has(npcId)) {
      const ltId = vals.get(15);
      if (ltId && ltId !== 0) {
        if (!npcToLt.has(npcId)) npcToLt.set(npcId, new Set());
        npcToLt.get(npcId).add(ltId);
        allLoottableIds.add(ltId);
      }
    }
  });
  console.log(`[quarm-db]   Found ${allLoottableIds.size} loot tables.`);

  // Step 4: Parse loottable_entries — build loottable -> Set<lootdropID> mapping
  // loottable_entries columns: loottable_id (0), lootdrop_id (1)
  console.log('[quarm-db] Parsing loottable_entries...');
  const ltToLd = new Map(); // loottableID -> Set<lootdropID>
  const allLootdropIds = new Set();
  parseTable(content, 'loottable_entries', [0, 1], (vals) => {
    const ltId = vals.get(0);
    if (allLoottableIds.has(ltId)) {
      const ldId = vals.get(1);
      if (!ltToLd.has(ltId)) ltToLd.set(ltId, new Set());
      ltToLd.get(ltId).add(ldId);
      allLootdropIds.add(ldId);
    }
  });
  console.log(`[quarm-db]   Found ${allLootdropIds.size} loot drops.`);

  // Step 5: Parse lootdrop_entries — build lootdrop -> Set<itemID> mapping
  // lootdrop_entries columns: lootdrop_id (0), item_id (1)
  console.log('[quarm-db] Parsing lootdrop_entries...');
  const ldToItems = new Map(); // lootdropID -> Set<itemID>
  const allItemIds = new Set();
  parseTable(content, 'lootdrop_entries', [0, 1], (vals) => {
    const ldId = vals.get(0);
    if (allLootdropIds.has(ldId)) {
      const itemId = vals.get(1);
      if (!ldToItems.has(ldId)) ldToItems.set(ldId, new Set());
      ldToItems.get(ldId).add(itemId);
      allItemIds.add(itemId);
    }
  });
  console.log(`[quarm-db]   Found ${allItemIds.size} item IDs.`);

  // Step 6: Parse items — get item details for our item IDs
  // items columns: id (0), Name (2), classes (23), price (25), magic (57), nodrop (62)
  console.log('[quarm-db] Parsing items...');
  const itemMap = new Map(); // id -> { name, classes, price, magic, nodrop }
  parseTable(content, 'items', [0, 2, 23, 25, 57, 62], (vals) => {
    const id = vals.get(0);
    if (allItemIds.has(id)) {
      itemMap.set(id, {
        name: vals.get(2),
        classes: vals.get(23) ?? 0,
        price: vals.get(25) ?? 0,
        magic: vals.get(57) ?? 0,
        nodrop: vals.get(62) ?? 0
      });
    }
  });
  console.log(`[quarm-db]   Found ${itemMap.size} items with details.`);

  // Step 7: Traverse the chain to build zone-item pairs
  console.log('[quarm-db] Building zone-to-item mapping...');
  const zoneItemPairs = []; // { itemId, zoneLower }
  const seen = new Set(); // dedup "itemId|zone"

  for (const [zoneLower, sgs] of zoneToSpawngroups) {
    for (const sg of sgs) {
      const npcs = sgToNpcs.get(sg);
      if (!npcs) continue;
      for (const npc of npcs) {
        const lts = npcToLt.get(npc);
        if (!lts) continue;
        for (const lt of lts) {
          const lds = ltToLd.get(lt);
          if (!lds) continue;
          for (const ld of lds) {
            const items = ldToItems.get(ld);
            if (!items) continue;
            for (const itemId of items) {
              const key = `${itemId}|${zoneLower}`;
              if (!seen.has(key) && itemMap.has(itemId)) {
                seen.add(key);
                zoneItemPairs.push({ itemId, zoneLower });
              }
            }
          }
        }
      }
    }
  }

  console.log(`[quarm-db]   Inserting ${zoneItemPairs.length} zone-item pairs...`);

  // Insert into DB
  const insert = db.prepare(`
    INSERT OR REPLACE INTO zone_items (item_id, item_name, zone_short, classes, price, nodrop, magic)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  const insertMany = db.transaction((pairs) => {
    for (const pair of pairs) {
      const item = itemMap.get(pair.itemId);
      if (!item) continue;
      insert.run(
        pair.itemId,
        item.name,
        pair.zoneLower,
        item.classes,
        item.price,
        item.nodrop,
        item.magic
      );
    }
  });

  insertMany(zoneItemPairs);
  console.log(`[quarm-db] Import complete.`);
}

// ---------------------------------------------------------------------------
// Query functions
// ---------------------------------------------------------------------------

/**
 * Return all zones sorted by long_name.
 * @returns {{ short_name: string, long_name: string }[]}
 */
function getAllZones() {
  const db = getDb();
  return db.prepare('SELECT short_name, long_name FROM zones ORDER BY long_name COLLATE NOCASE').all();
}

/**
 * Look up short_name for a given long_name (case-insensitive).
 * @param {string} longName
 * @returns {string|null}
 */
function getZoneShortName(longName) {
  const db = getDb();
  const row = db.prepare('SELECT short_name FROM zones WHERE long_name = ? COLLATE NOCASE').get(longName);
  return row ? row.short_name : null;
}

/**
 * Search zone_items by item name (LIKE match).
 * @param {string} query - Search term
 * @param {number} [limit=25] - Max results
 * @returns {{ item_id: number, item_name: string, zone_short: string, classes: number, price: number, nodrop: number, magic: number }[]}
 */
function searchItems(query, limit = 25) {
  const db = getDb();
  return db.prepare(`
    SELECT item_id, item_name, zone_short, classes, price, nodrop, magic
    FROM zone_items
    WHERE item_name LIKE ?
    ORDER BY item_name COLLATE NOCASE
    LIMIT ?
  `).all(`%${query}%`, limit);
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  initCache,
  findDumpFile,
  importZones,
  importItemsForZones,
  getAllZones,
  getZoneShortName,
  searchItems,
  getDb,
  CACHE_DB
};
