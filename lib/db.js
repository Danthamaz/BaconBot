/**
 * SQLite database layer using better-sqlite3 (synchronous).
 *
 * Schema:
 *   raids          — one row per imported log session
 *   attendance     — one row per unique character per raid
 *   loot           — one row per loot event per raid
 *   player_aliases — maps character names → canonical player names (for alt tracking)
 *
 * Alt / multi-character support:
 *   Use linkCharacter('Altname', 'Mainname') to associate an alt with a player.
 *   Queries that accept a player name will automatically resolve all known alts.
 */

'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const DB_PATH = path.join(__dirname, '..', 'raid_data.db');

let _db = null;

function getDb() {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma('journal_mode = WAL'); // better concurrent read performance
    _db.pragma('foreign_keys = ON');
    initSchema(_db);
  }
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS raids (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      name           TEXT    NOT NULL,
      zone           TEXT    NOT NULL,
      start_time     INTEGER NOT NULL,
      end_time       INTEGER NOT NULL,
      character_name TEXT,
      submitted_by   TEXT,
      submitted_at   INTEGER NOT NULL
    );

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

    CREATE TABLE IF NOT EXISTS loot (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      raid_id     INTEGER NOT NULL REFERENCES raids(id) ON DELETE CASCADE,
      player_name TEXT    NOT NULL,
      item_name   TEXT    NOT NULL,
      looted_at   INTEGER NOT NULL,
      zone        TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_attendance_player ON attendance(player_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_loot_player       ON loot(player_name COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_loot_item         ON loot(item_name   COLLATE NOCASE);
    CREATE INDEX IF NOT EXISTS idx_raids_start       ON raids(start_time DESC);

    -- Alt tracking: maps any in-game character name to a Discord user.
    -- discord_id  is the stable snowflake (never changes, used for all lookups).
    -- discord_tag is the display name at link time (may drift, purely cosmetic).
    CREATE TABLE IF NOT EXISTS player_aliases (
      character_name TEXT PRIMARY KEY COLLATE NOCASE,
      discord_id     TEXT NOT NULL,
      discord_tag    TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_aliases_discord ON player_aliases(discord_id);

    -- Sleeper's Tomb key holders
    CREATE TABLE IF NOT EXISTS key_holders (
      character_name TEXT    PRIMARY KEY COLLATE NOCASE,
      discord_tag    TEXT    NOT NULL,
      added_at       INTEGER NOT NULL
    );

    -- TOD tracker: mob registry
    CREATE TABLE IF NOT EXISTS tod_mobs (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      name          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
      lockout_hours REAL    NOT NULL,
      added_by      TEXT,
      added_at      INTEGER NOT NULL
    );

    -- TOD tracker: kill records
    CREATE TABLE IF NOT EXISTS tod_kills (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      mob_id      INTEGER NOT NULL REFERENCES tod_mobs(id) ON DELETE CASCADE,
      killed_at   INTEGER NOT NULL,
      recorded_by TEXT,
      recorded_at INTEGER NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tod_kills_mob ON tod_kills(mob_id, killed_at DESC);
  `);
}

// ── Write operations ───────────────────────────────────────────────────────

/**
 * Save a full raid record (raid metadata + attendance + loot) in one transaction.
 * Returns the new raid ID.
 */
function saveRaid({ name, zone, startTime, endTime, characterName, submittedBy, attendance, loot }) {
  const db = getDb();

  const stmtRaid = db.prepare(`
    INSERT INTO raids (name, zone, start_time, end_time, character_name, submitted_by, submitted_at)
    VALUES (@name, @zone, @startTime, @endTime, @characterName, @submittedBy, @submittedAt)
  `);

  const stmtAttend = db.prepare(`
    INSERT OR REPLACE INTO attendance
      (raid_id, player_name, level, class, race, guild, first_seen, last_seen)
    VALUES (@raidId, @playerName, @level, @class, @race, @guild, @firstSeen, @lastSeen)
  `);

  const stmtLoot = db.prepare(`
    INSERT INTO loot (raid_id, player_name, item_name, looted_at, zone)
    VALUES (@raidId, @playerName, @itemName, @lootedAt, @zone)
  `);

  const run = db.transaction(() => {
    const { lastInsertRowid: raidId } = stmtRaid.run({
      name,
      zone,
      startTime:     startTime.getTime(),
      endTime:       endTime.getTime(),
      characterName: characterName || null,
      submittedBy:   submittedBy   || null,
      submittedAt:   Date.now(),
    });

    for (const a of attendance) {
      stmtAttend.run({
        raidId,
        playerName: a.name,
        level:      a.level     ?? null,
        class:      a.class     ?? null,
        race:       a.race      ?? null,
        guild:      a.guild     ?? null,
        firstSeen:  a.firstSeen ? a.firstSeen.getTime() : null,
        lastSeen:   a.lastSeen  ? a.lastSeen.getTime()  : null,
      });
    }

    for (const l of loot) {
      stmtLoot.run({
        raidId,
        playerName: l.playerName,
        itemName:   l.itemName,
        lootedAt:   l.timestamp.getTime(),
        zone:       l.zone || null,
      });
    }

    return raidId;
  });

  return run();
}

/**
 * Merge additional attendance and loot into an existing raid.
 * - Attendance: upserts (replaces) so fresher character data wins.
 * - Loot: skips exact duplicates (same player + item + timestamp).
 * Returns { newLoot } count of loot rows actually inserted.
 */
function mergeIntoRaid(raidId, { attendance, loot }) {
  const db = getDb();

  const stmtAttend = db.prepare(`
    INSERT OR REPLACE INTO attendance
      (raid_id, player_name, level, class, race, guild, first_seen, last_seen)
    VALUES (@raidId, @playerName, @level, @class, @race, @guild, @firstSeen, @lastSeen)
  `);

  const stmtLoot = db.prepare(`
    INSERT INTO loot (raid_id, player_name, item_name, looted_at, zone)
    SELECT @raidId, @playerName, @itemName, @lootedAt, @zone
    WHERE NOT EXISTS (
      SELECT 1 FROM loot
      WHERE raid_id    = @raidId
        AND player_name = @playerName COLLATE NOCASE
        AND item_name   = @itemName   COLLATE NOCASE
        AND looted_at   = @lootedAt
    )
  `);

  return db.transaction(() => {
    for (const a of attendance) {
      stmtAttend.run({
        raidId,
        playerName: a.name,
        level:      a.level     ?? null,
        class:      a.class     ?? null,
        race:       a.race      ?? null,
        guild:      a.guild     ?? null,
        firstSeen:  a.firstSeen ? a.firstSeen.getTime() : null,
        lastSeen:   a.lastSeen  ? a.lastSeen.getTime()  : null,
      });
    }

    let newLoot = 0;
    for (const l of loot) {
      const r = stmtLoot.run({
        raidId,
        playerName: l.playerName,
        itemName:   l.itemName,
        lootedAt:   l.timestamp.getTime(),
        zone:       l.zone || null,
      });
      if (r.changes > 0) newLoot++;
    }

    return { newLoot };
  })();
}

/**
 * Update editable fields on a raid. Only non-null values are changed.
 */
function updateRaid(id, { name, zone, startTime, endTime } = {}) {
  const sets = [];
  const vals = [];
  if (name      != null) { sets.push('name = ?');       vals.push(name); }
  if (zone      != null) { sets.push('zone = ?');       vals.push(zone); }
  if (startTime != null) { sets.push('start_time = ?'); vals.push(startTime.getTime()); }
  if (endTime   != null) { sets.push('end_time = ?');   vals.push(endTime.getTime()); }
  if (sets.length === 0) return;
  vals.push(id);
  getDb().prepare(`UPDATE raids SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
}

/**
 * Delete a raid and all its associated attendance/loot rows.
 */
function deleteRaid(id) {
  getDb().prepare('DELETE FROM raids WHERE id = ?').run(id);
}

// ── Read operations ────────────────────────────────────────────────────────

/** List raids newest-first, with aggregated counts. Optionally filter by zone and/or date range. */
function getRaids(limit = 10, offset = 0, { zone, dateStart, dateEnd } = {}) {
  const conds  = [];
  const params = [];
  if (zone)                          { conds.push('(r.zone LIKE ? ESCAPE \'\\\' OR r.name LIKE ? ESCAPE \'\\\')'); const z = `%${zone.replace(/[%_\\]/g, '\\$&')}%`; params.push(z, z); }
  if (dateStart != null)             { conds.push('r.start_time >= ?');             params.push(dateStart); }
  if (dateEnd   != null)             { conds.push('r.start_time <= ?');             params.push(dateEnd);   }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return getDb().prepare(`
    SELECT
      r.*,
      COUNT(DISTINCT a.player_name) AS attendance_count,
      COUNT(DISTINCT l.id)          AS loot_count
    FROM raids r
    LEFT JOIN attendance a ON a.raid_id = r.id
    LEFT JOIN loot       l ON l.raid_id = r.id
    ${where}
    GROUP BY r.id
    ORDER BY r.start_time DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);
}

/** Total number of recorded raids, respecting the same optional filters as getRaids. */
function getRaidCount({ zone, dateStart, dateEnd } = {}) {
  const conds  = [];
  const params = [];
  if (zone)      { conds.push('(zone LIKE ? ESCAPE \'\\\' OR name LIKE ? ESCAPE \'\\\')'); const z = `%${zone.replace(/[%_\\]/g, '\\$&')}%`; params.push(z, z); }
  if (dateStart != null) { conds.push('start_time >= ?');   params.push(dateStart); }
  if (dateEnd   != null) { conds.push('start_time <= ?');   params.push(dateEnd);   }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  return getDb().prepare(`SELECT COUNT(*) AS n FROM raids ${where}`).get(...params).n;
}

/** Single raid row. */
function getRaid(id) {
  return getDb().prepare('SELECT * FROM raids WHERE id = ?').get(id);
}

/**
 * Find a raid whose start_time falls on a given UTC date.
 * Used to auto-detect existing raids for merging when multiple
 * people upload logs for the same raid day.
 * @param {string} dateStr - "YYYY-MM-DD"
 */
function getRaidByDate(dateStr) {
  const dayStart = new Date(dateStr + 'T00:00:00Z').getTime();
  const dayEnd   = new Date(dateStr + 'T23:59:59Z').getTime();
  return getDb().prepare(
    'SELECT * FROM raids WHERE start_time >= ? AND start_time <= ? ORDER BY start_time ASC LIMIT 1'
  ).get(dayStart, dayEnd) ?? null;
}

/** All attendance rows for one raid, sorted by player name. */
function getRaidAttendance(raidId) {
  return getDb().prepare(`
    SELECT * FROM attendance WHERE raid_id = ? ORDER BY player_name COLLATE NOCASE
  `).all(raidId);
}

/** All loot rows for one raid, in chronological order. */
function getRaidLoot(raidId) {
  return getDb().prepare(`
    SELECT * FROM loot WHERE raid_id = ? ORDER BY looted_at
  `).all(raidId);
}

// ── Alt / alias helpers (Discord-ID-based) ─────────────────────────────────

/** Normalize a character name to EQ proper case (e.g. "lyri" → "Lyri"). */
function properCase(name) {
  const t = name.trim();
  return t.charAt(0).toUpperCase() + t.slice(1).toLowerCase();
}

/**
 * Link an in-game character name to a Discord user.
 * Safe to call repeatedly — updates the entry if it already exists.
 * Character name is always stored in proper case (e.g. "Lyri").
 *
 * @param {string} characterName  - In-game name, e.g. "Lyrimage"
 * @param {string} discordId      - Discord user snowflake, e.g. "123456789012345678"
 * @param {string} discordTag     - Display name at link time, e.g. "lyri" (cosmetic only)
 */
function linkCharacter(characterName, discordId, discordTag) {
  getDb().prepare(`
    INSERT INTO player_aliases (character_name, discord_id, discord_tag)
    VALUES (?, ?, ?)
    ON CONFLICT(character_name) DO UPDATE SET
      discord_id  = excluded.discord_id,
      discord_tag = excluded.discord_tag
  `).run(properCase(characterName), discordId, discordTag);
}

/**
 * Remove a character's Discord link.
 * Other characters belonging to the same Discord user are unaffected.
 */
function unlinkCharacter(characterName) {
  getDb().prepare(
    'DELETE FROM player_aliases WHERE character_name = ? COLLATE NOCASE'
  ).run(characterName);
}

/**
 * Return all character names linked to a given Discord user ID.
 * Returns an empty array if none are linked.
 */
function getCharsForDiscordId(discordId) {
  return getDb().prepare(
    'SELECT character_name FROM player_aliases WHERE discord_id = ? ORDER BY character_name COLLATE NOCASE'
  ).all(discordId).map(r => r.character_name);
}

/**
 * Return the Discord info (id + tag) for a character, or null if not linked.
 */
function getDiscordInfoForChar(characterName) {
  return getDb().prepare(
    'SELECT discord_id, discord_tag FROM player_aliases WHERE character_name = ? COLLATE NOCASE'
  ).get(characterName) ?? null;
}

/**
 * Resolve a lookup term to a list of character names to search.
 * Accepts either:
 *   - A Discord user ID ("123456789…")  → all chars for that user
 *   - An in-game character name         → all chars for whoever owns that character
 * Falls back to [term] if no aliases are found.
 */
function resolveCharacterNames(term) {
  const db = getDb();

  // Try as a Discord ID first (all digits, 17-20 chars)
  if (/^\d{17,20}$/.test(term)) {
    const chars = getCharsForDiscordId(term);
    return chars.length > 0 ? chars : [term];
  }

  // Try as a character name → get the discord_id → get all their chars
  const row = db.prepare(
    'SELECT discord_id FROM player_aliases WHERE character_name = ? COLLATE NOCASE'
  ).get(term);

  if (row) {
    const chars = getCharsForDiscordId(row.discord_id);
    return chars.length > 0 ? chars : [term];
  }

  return [term];
}

/**
 * Return all alias mappings grouped by Discord user, for /player list.
 */
function getAllAliases() {
  return getDb().prepare(`
    SELECT discord_id, discord_tag,
           GROUP_CONCAT(character_name, ', ') AS characters,
           COUNT(*) AS char_count
    FROM player_aliases
    GROUP BY discord_id
    ORDER BY discord_tag COLLATE NOCASE
  `).all();
}

// ── Player-aware read operations ───────────────────────────────────────────

/**
 * All raids attended by a Discord user (or a character name that resolves to one).
 * @param {string} term  - Discord user ID or in-game character name
 */
function getPlayerAttendance(term) {
  const chars = resolveCharacterNames(term);
  const placeholders = chars.map(() => '?').join(', ');
  return getDb().prepare(`
    SELECT r.id, r.name, r.zone, r.start_time,
           a.player_name AS character_name, a.level, a.class, a.guild
    FROM attendance a
    JOIN raids r ON r.id = a.raid_id
    WHERE a.player_name IN (${placeholders}) COLLATE NOCASE
    ORDER BY r.start_time DESC
  `).all(...chars);
}

/**
 * All loot received by a Discord user across all their characters.
 * @param {string} term  - Discord user ID or in-game character name
 */
function getPlayerLoot(term) {
  const chars = resolveCharacterNames(term);
  const placeholders = chars.map(() => '?').join(', ');
  return getDb().prepare(`
    SELECT l.*, r.name AS raid_name, r.zone AS raid_zone
    FROM loot l
    JOIN raids r ON r.id = l.raid_id
    WHERE l.player_name IN (${placeholders}) COLLATE NOCASE
    ORDER BY l.looted_at DESC
  `).all(...chars);
}

/** Search loot records by partial item name (case-insensitive). */
function searchItemLoot(itemName, limit = 50) {
  return getDb().prepare(`
    SELECT l.*, r.name AS raid_name
    FROM loot l
    JOIN raids r ON r.id = l.raid_id
    WHERE l.item_name LIKE ? ESCAPE '\\'
    ORDER BY l.looted_at DESC
    LIMIT ?
  `).all(`%${itemName.replace(/[%_\\]/g, '\\$&')}%`, limit);
}

/**
 * Enrich an array of attendance rows with Discord info.
 * Adds `discord_id` and `discord_tag` fields to each row (null if not linked).
 */
function enrichWithDiscordInfo(attendanceRows) {
  const db   = getDb();
  const stmt = db.prepare(
    'SELECT discord_id, discord_tag FROM player_aliases WHERE character_name = ? COLLATE NOCASE'
  );
  return attendanceRows.map(row => {
    const info = stmt.get(row.player_name);
    return {
      ...row,
      discord_id:  info?.discord_id  ?? null,
      discord_tag: info?.discord_tag ?? null,
    };
  });
}

// ── Voice / Discord-event raid helpers ─────────────────────────────────────

/**
 * Create a raid row with no attendance or loot (used for Discord-event-driven raids).
 * Returns the new raid ID.
 */
function createRaid({ name, zone, startTime, endTime, submittedBy }) {
  const { lastInsertRowid } = getDb().prepare(`
    INSERT INTO raids (name, zone, start_time, end_time, character_name, submitted_by, submitted_at)
    VALUES (@name, @zone, @startTime, @endTime, NULL, @submittedBy, @submittedAt)
  `).run({
    name,
    zone,
    startTime:   startTime.getTime(),
    endTime:     endTime.getTime(),
    submittedBy: submittedBy || null,
    submittedAt: Date.now(),
  });
  return lastInsertRowid;
}

/**
 * Upsert a voice-attendance row.
 * On conflict (same raid + player) only last_seen is updated (first_seen is preserved).
 */
function upsertVoiceAttendance(raidId, playerName, _discordId, firstSeen, lastSeen) {
  getDb().prepare(`
    INSERT INTO attendance (raid_id, player_name, first_seen, last_seen)
    VALUES (@raidId, @playerName, @firstSeen, @lastSeen)
    ON CONFLICT(raid_id, player_name) DO UPDATE SET
      last_seen = COALESCE(excluded.last_seen, attendance.last_seen)
  `).run({
    raidId,
    playerName,
    firstSeen: firstSeen ? firstSeen.getTime() : null,
    lastSeen:  lastSeen  ? lastSeen.getTime()  : null,
  });
}

/** Update only the end_time of a raid. */
function updateRaidEndTime(raidId, endTime) {
  getDb().prepare('UPDATE raids SET end_time = ? WHERE id = ?').run(endTime.getTime(), raidId);
}

/**
 * Return the first in-game character name linked to a Discord user ID, or null.
 */
function getCharacterByDiscordId(discordId) {
  const row = getDb().prepare(
    'SELECT character_name FROM player_aliases WHERE discord_id = ? LIMIT 1'
  ).get(discordId);
  return row ? row.character_name : null;
}

// ── Key holder operations ──────────────────────────────────────────────────

/**
 * Add or update a Sleeper's Tomb key holder.
 * @param {string} characterName - In-game character name (stored in proper case)
 * @param {string} discordTag    - Discord username / display tag (cosmetic)
 */
function addKeyHolder(characterName, discordTag) {
  getDb().prepare(`
    INSERT INTO key_holders (character_name, discord_tag, added_at)
    VALUES (?, ?, ?)
    ON CONFLICT(character_name) DO UPDATE SET
      discord_tag = excluded.discord_tag
  `).run(properCase(characterName), discordTag, Date.now());
}

/** Remove a key holder by character name. */
function removeKeyHolder(characterName) {
  getDb().prepare(
    'DELETE FROM key_holders WHERE character_name = ? COLLATE NOCASE'
  ).run(characterName);
}

/**
 * Return all key holders, enriched with discord_id from player_aliases when available.
 * Sorted alphabetically by character name.
 */
function getKeyHolders() {
  return getDb().prepare(`
    SELECT k.character_name, k.discord_tag, k.added_at, p.discord_id
    FROM key_holders k
    LEFT JOIN player_aliases p ON p.character_name = k.character_name COLLATE NOCASE
    ORDER BY k.character_name COLLATE NOCASE
  `).all();
}

// ── TOD tracker operations ─────────────────────────────────────────────────

function addTodMob(name, lockoutHours, addedBy) {
  return getDb().prepare(`
    INSERT INTO tod_mobs (name, lockout_hours, added_by, added_at)
    VALUES (?, ?, ?, ?)
  `).run(name, lockoutHours, addedBy || null, Date.now());
}

function updateTodMob(name, lockoutHours) {
  getDb().prepare(
    'UPDATE tod_mobs SET lockout_hours = ? WHERE name = ? COLLATE NOCASE'
  ).run(lockoutHours, name);
}

function removeTodMob(name) {
  getDb().prepare('DELETE FROM tod_mobs WHERE name = ? COLLATE NOCASE').run(name);
}

function getTodMob(name) {
  return getDb().prepare(
    'SELECT * FROM tod_mobs WHERE name = ? COLLATE NOCASE'
  ).get(name) ?? null;
}

function searchTodMobs(partial) {
  if (!partial) {
    return getDb().prepare('SELECT * FROM tod_mobs ORDER BY name COLLATE NOCASE LIMIT 25').all();
  }
  return getDb().prepare(`
    SELECT * FROM tod_mobs
    WHERE name LIKE ? ESCAPE '\\'
    ORDER BY name COLLATE NOCASE
    LIMIT 25
  `).all(`%${partial.replace(/[%_\\]/g, '\\$&')}%`);
}

function recordTodKill(mobId, killedAt, recordedBy) {
  return getDb().prepare(`
    INSERT INTO tod_kills (mob_id, killed_at, recorded_by, recorded_at)
    VALUES (?, ?, ?, ?)
  `).run(mobId, killedAt, recordedBy || null, Date.now());
}

function getLatestTodKill(mobId) {
  return getDb().prepare(
    'SELECT * FROM tod_kills WHERE mob_id = ? ORDER BY killed_at DESC LIMIT 1'
  ).get(mobId) ?? null;
}

function getTodKillHistory(mobId, limit = 10) {
  return getDb().prepare(
    'SELECT * FROM tod_kills WHERE mob_id = ? ORDER BY killed_at DESC LIMIT ?'
  ).all(mobId, limit);
}

function undoLastTodKill(mobId) {
  const last = getLatestTodKill(mobId);
  if (!last) return null;
  getDb().prepare('DELETE FROM tod_kills WHERE id = ?').run(last.id);
  return last;
}

function getTodStatus() {
  return getDb().prepare(`
    SELECT m.*, k.killed_at AS last_killed_at, k.recorded_by AS last_recorded_by
    FROM tod_mobs m
    LEFT JOIN (
      SELECT mob_id, killed_at, recorded_by,
             ROW_NUMBER() OVER (PARTITION BY mob_id ORDER BY killed_at DESC) AS rn
      FROM tod_kills
    ) k ON k.mob_id = m.id AND k.rn = 1
    ORDER BY m.name COLLATE NOCASE
  `).all();
}

module.exports = {
  getDb,
  saveRaid,
  mergeIntoRaid,
  updateRaid,
  deleteRaid,
  getRaids,
  getRaidCount,
  getRaid,
  getRaidAttendance,
  getRaidLoot,
  getPlayerAttendance,
  getPlayerLoot,
  searchItemLoot,
  // Alt / alias management
  linkCharacter,
  unlinkCharacter,
  getCharsForDiscordId,
  getDiscordInfoForChar,
  getAllAliases,
  resolveCharacterNames,
  enrichWithDiscordInfo,
  getRaidByDate,
  // Key holders
  addKeyHolder,
  removeKeyHolder,
  getKeyHolders,
  // Voice / Discord-event raid helpers
  createRaid,
  upsertVoiceAttendance,
  updateRaidEndTime,
  getCharacterByDiscordId,
  // TOD tracker
  addTodMob,
  updateTodMob,
  removeTodMob,
  getTodMob,
  searchTodMobs,
  recordTodKill,
  getLatestTodKill,
  getTodKillHistory,
  undoLastTodKill,
  getTodStatus,
};
