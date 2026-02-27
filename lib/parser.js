/**
 * EverQuest Project Quarm log parser
 *
 * Parses a raw EQ log file and extracts attendance and loot data
 * within a user-specified time window and zone filter.
 *
 * Key log patterns handled:
 *   [Thu Jan 22 20:54:23 2026] You have entered The Fungus Grove.
 *   [Thu Jan 22 20:54:27 2026] [60 Virtuoso] Lyri (Vah Shir) <Intervention>
 *   [Thu Jan 22 20:54:27 2026] There are 12 players in Fungus Grove.
 *   [Thu Jan 22 16:22:38 2026] --You have looted a Shiknar Ichor.--
 *   [Fri Jan 23 06:21:34 2026] --Risingdarkness has looted a Phase Spider Blood.--
 */

'use strict';

const fs = require('fs');
const readline = require('readline');

// --- Regex patterns ---

// Every EQ log line starts with a bracketed timestamp
const LINE_RE = /^\[(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\] (.*)$/;

// Zone transitions
const ZONE_ENTRY_RE = /^You have entered (.+)\.$/;

// /who block footer — tells us the zone and ends the player list block
const WHO_FOOTER_RE = /^There are \d+ players in (.+)\.$/;

// /who player line: [60 Virtuoso] Lyri (Vah Shir) <Intervention>
// Also handles: [ANONYMOUS] Lyri  <Intervention>
const WHO_PLAYER_RE = /^\[(\d+ [^\]]+|ANONYMOUS)\] ([\w`'-]+)(?:\s+\(([^)]+)\))?(?:\s+<([^>]+)>)?/;

// Loot events
const SELF_LOOT_RE  = /^--You have looted a (.+?)\.--$/;
const OTHER_LOOT_RE = /^--([\w`'-]+) has looted a (.+?)\.--$/;

// --- Month lookup for manual timestamp parsing ---
const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Parse an EQ log timestamp string into a JS Date.
 * Input format: "Thu Jan 22 16:19:28 2026"
 */
function parseEQDate(ts) {
  const m = ts.match(/(\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})/);
  if (!m) return null;
  const [, mon, day, h, min, s, year] = m;
  return new Date(+year, MONTHS[mon], +day, +h, +min, +s);
}

/**
 * Normalize a zone name for fuzzy comparison:
 * strips leading "The ", lowercases, trims whitespace.
 */
function normalizeZone(name) {
  return name.toLowerCase().replace(/^the\s+/, '').trim();
}

/**
 * Check whether a zone name matches any of the user-supplied filters.
 * Uses case-insensitive substring matching in both directions so that
 * "fungus" matches "Fungus Grove" and vice versa.
 */
function zoneMatchesFilters(zoneName, filters) {
  if (!zoneName || !filters.length) return false;
  const norm = normalizeZone(zoneName);
  return filters.some(f => norm.includes(f) || f.includes(norm));
}

/**
 * Parse an EQ log file and return attendance + loot data.
 *
 * @param {object}   opts
 * @param {string}   opts.filePath       - Absolute path to the .txt log file
 * @param {Date}     opts.startTime      - Beginning of the time window to capture
 * @param {Date}     opts.endTime        - End of the time window to capture
 * @param {string[]} opts.zones          - Zone name filters (partial, case-insensitive)
 * @param {string}   opts.characterName  - The log owner's in-game name (for self-loot attribution)
 * @param {function} [opts.onProgress]   - Optional callback(linesProcessed) for progress reporting
 *
 * @returns {Promise<{ attendance: object[], loot: object[], lineCount: number }>}
 */
async function parseLog({ filePath, startTime, endTime, zones, characterName, onProgress }) {
  const zoneFilters = zones.map(normalizeZone);

  // Keyed by lowercased player name so duplicates across /who snapshots merge cleanly
  const attendanceMap = new Map();
  const lootEvents = [];

  // --- Parser state ---
  let currentZone  = null; // zone we're currently in (from "You have entered X.")
  let inWhoBlock   = false;
  let whoBlockTime = null;
  let whoPlayers   = [];
  let lineCount    = 0;

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineCount++;

    // Report progress every 50 000 lines
    if (onProgress && lineCount % 50000 === 0) {
      onProgress(lineCount);
    }

    // Every usable line: [timestamp] content
    const lineMatch = line.match(LINE_RE);
    if (!lineMatch) continue;

    const [, tsStr, content] = lineMatch;
    const ts = parseEQDate(tsStr);
    if (!ts) continue;

    // --- Time window filter ---
    if (ts < startTime || ts > endTime) continue;

    // ── Zone entry ────────────────────────────────────────────────
    const zoneEntryMatch = content.match(ZONE_ENTRY_RE);
    if (zoneEntryMatch) {
      currentZone = zoneEntryMatch[1];
      inWhoBlock  = false; // safety reset
      continue;
    }

    // ── /who block start ──────────────────────────────────────────
    if (content === 'Players on EverQuest:') {
      inWhoBlock   = true;
      whoBlockTime = ts;
      whoPlayers   = [];
      continue;
    }

    // ── Lines inside a /who block ─────────────────────────────────
    if (inWhoBlock) {
      // Visual separator — skip
      if (content === '---------------------------') continue;

      // Footer: "There are N players in ZoneName."
      const footerMatch = content.match(WHO_FOOTER_RE);
      if (footerMatch) {
        const whoZone = footerMatch[1];
        inWhoBlock = false;

        // Only record attendance if this snapshot is in a matching zone
        if (zoneMatchesFilters(whoZone, zoneFilters)) {
          for (const p of whoPlayers) {
            const key = p.name.toLowerCase();
            const existing = attendanceMap.get(key);
            if (!existing) {
              attendanceMap.set(key, {
                ...p,
                firstSeen: whoBlockTime,
                lastSeen:  whoBlockTime,
              });
            } else {
              if (whoBlockTime < existing.firstSeen) existing.firstSeen = whoBlockTime;
              if (whoBlockTime > existing.lastSeen)  existing.lastSeen  = whoBlockTime;
            }
          }
        }
        continue;
      }

      // Player entry line: [60 Virtuoso] Lyri (Vah Shir) <Intervention>
      const playerMatch = content.match(WHO_PLAYER_RE);
      if (playerMatch) {
        const [, levelClass, name, race, guild] = playerMatch;
        let level = null;
        let cls   = null;
        if (levelClass !== 'ANONYMOUS') {
          const parts = levelClass.split(' ');
          level = parseInt(parts[0], 10) || null;
          cls   = parts.slice(1).join(' ') || null;
        }
        whoPlayers.push({
          name,
          level,
          class: cls,
          race:  race  || null,
          guild: guild || null,
        });
      }
      continue;
    }

    // ── Loot events — only when current zone matches ──────────────
    if (!zoneMatchesFilters(currentZone, zoneFilters)) continue;

    // Self loot: --You have looted a ItemName.--
    const selfLoot = content.match(SELF_LOOT_RE);
    if (selfLoot) {
      lootEvents.push({
        playerName: characterName,
        itemName:   selfLoot[1],
        timestamp:  ts,
        zone:       currentZone,
      });
      continue;
    }

    // Other player loot: --PlayerName has looted a ItemName.--
    const otherLoot = content.match(OTHER_LOOT_RE);
    if (otherLoot) {
      lootEvents.push({
        playerName: otherLoot[1],
        itemName:   otherLoot[2],
        timestamp:  ts,
        zone:       currentZone,
      });
    }
  }

  return {
    attendance: Array.from(attendanceMap.values()),
    loot: lootEvents,
    lineCount,
  };
}

// ── Auto-parse: detect raid sessions automatically ─────────────────────────

/**
 * Raid schedule: Wed, Fri, Sat, Sun between 13:00–17:00 UTC.
 */
const RAID_UTC_DAYS  = new Set([0, 3, 5, 6]); // Sun=0, Wed=3, Fri=5, Sat=6
const RAID_UTC_START = 13;
const RAID_UTC_END   = 17;

const APPROVED_ZONES = [
  'Plane of Fear', 'Plane of Hate', 'Sebilis', 'Katta Castellum',
  "Kedge Keep", "Nagafen's Lair", 'Permafrost', "Veeshan's Peak",
  'Timorous Deep', 'Dreadlands', 'Chardok', 'Dragon Necropolis',
  'Kael Drakkel', 'Temple of Veeshan', 'Thurgadin', 'Akheva Ruins',
  "Greig's End", 'Acrylia Caverns', 'Ssraeshza Temple', 'Umbral Plains',
  'Vex Thal', 'The Deep',
];
const APPROVED_ZONE_FILTERS = APPROVED_ZONES.map(normalizeZone);

function isApprovedZone(zoneName) {
  return !!zoneName && zoneMatchesFilters(zoneName, APPROVED_ZONE_FILTERS);
}

/**
 * Convert a log's local timestamp to a UTC Date using the IANA timezone string.
 *
 * Strategy:
 *  1. Treat the local numbers as if they were UTC ("fakeUTC").
 *  2. Ask Intl what that instant looks like in the target timezone ("localView").
 *  3. The difference between fakeUTC and localView is the timezone's UTC offset.
 *  4. True UTC = fakeUTC + offset.
 *
 * This correctly handles DST transitions automatically.
 */
function localToUTC(year, month, day, hour, minute, second, timezone) {
  const fakeUTC   = new Date(Date.UTC(year, month, day, hour, minute, second));
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric', month: 'numeric', day: 'numeric',
    hour: 'numeric', minute: 'numeric', second: 'numeric',
    hour12: false,
  });

  const parts = {};
  formatter.formatToParts(fakeUTC).forEach(p => { parts[p.type] = +p.value; });

  const h = parts.hour === 24 ? 0 : parts.hour;
  const localViewUTC = Date.UTC(parts.year, parts.month - 1, parts.day, h, parts.minute, parts.second);
  const offset = fakeUTC.getTime() - localViewUTC;
  return new Date(fakeUTC.getTime() + offset);
}

/** Parse an EQ timestamp and convert directly to UTC using the given timezone. */
function parseEQDateUTC(tsStr, timezone) {
  const m = tsStr.match(/(\w{3}) +(\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (\d{4})/);
  if (!m) return null;
  const [, mon, day, h, min, s, year] = m;
  return localToUTC(+year, MONTHS[mon], +day, +h, +min, +s, timezone);
}

function isInRaidWindow(utcDate) {
  const h = utcDate.getUTCHours();
  return RAID_UTC_DAYS.has(utcDate.getUTCDay()) &&
         h >= RAID_UTC_START && h < RAID_UTC_END;
}

const DAY_NAMES = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

/**
 * Automatically scan an entire EQ log and detect raid sessions.
 * A session is any eligible day (Wed/Fri/Sat/Sun) where raid-window
 * timestamps occur while the log owner is in an approved zone.
 *
 * @param {object}   opts
 * @param {string}   opts.filePath       - Path to the .txt log file
 * @param {string}   opts.timezone       - IANA timezone of the log owner, e.g. "America/Phoenix"
 * @param {string}   opts.characterName  - Log owner's character name (for self-loot)
 * @param {function} [opts.onProgress]   - Optional callback(linesProcessed)
 *
 * @returns {Promise<{ sessions: RaidSession[], lineCount: number }>}
 */
async function autoParseLog({ filePath, timezone, characterName, onProgress }) {
  // sessions keyed by UTC date string "YYYY-MM-DD"
  const sessionMap = new Map();

  let currentZone   = null;
  let inWhoBlock    = false;
  let whoBlockUTC   = null;
  let whoPlayers    = [];
  let lineCount     = 0;

  function getSession(utcDate) {
    const key = utcDate.toISOString().slice(0, 10);
    if (!sessionMap.has(key)) {
      sessionMap.set(key, {
        date:          key,
        dayName:       DAY_NAMES[utcDate.getUTCDay()],
        attendanceMap: new Map(),
        loot:          [],
        zones:         new Set(),
        firstSeen:     utcDate,
        lastSeen:      utcDate,
      });
    }
    const s = sessionMap.get(key);
    if (utcDate > s.lastSeen) s.lastSeen = utcDate;
    return s;
  }

  const fileStream = fs.createReadStream(filePath, { encoding: 'utf8' });
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  for await (const line of rl) {
    lineCount++;
    if (onProgress && lineCount % 50000 === 0) onProgress(lineCount);

    const lineMatch = line.match(LINE_RE);
    if (!lineMatch) continue;

    const [, tsStr, content] = lineMatch;
    const utcTs = parseEQDateUTC(tsStr, timezone);
    if (!utcTs) continue;

    // Always track zone transitions regardless of window
    const zoneEntry = content.match(ZONE_ENTRY_RE);
    if (zoneEntry) {
      currentZone = zoneEntry[1];
      inWhoBlock  = false;
      continue;
    }

    // /who block start — only process if inside a raid window
    if (content === 'Players on EverQuest:') {
      if (isInRaidWindow(utcTs)) {
        inWhoBlock  = true;
        whoBlockUTC = utcTs;
        whoPlayers  = [];
      }
      continue;
    }

    if (inWhoBlock) {
      if (content === '---------------------------') continue;

      const footerMatch = content.match(WHO_FOOTER_RE);
      if (footerMatch) {
        const whoZone = footerMatch[1];
        inWhoBlock = false;

        if (isApprovedZone(whoZone) && isInRaidWindow(whoBlockUTC)) {
          const session = getSession(whoBlockUTC);
          session.zones.add(whoZone);

          for (const p of whoPlayers) {
            const key      = p.name.toLowerCase();
            const existing = session.attendanceMap.get(key);
            if (!existing) {
              session.attendanceMap.set(key, { ...p, firstSeen: whoBlockUTC, lastSeen: whoBlockUTC });
            } else {
              if (whoBlockUTC < existing.firstSeen) existing.firstSeen = whoBlockUTC;
              if (whoBlockUTC > existing.lastSeen)  existing.lastSeen  = whoBlockUTC;
            }
          }
        }
        continue;
      }

      const playerMatch = content.match(WHO_PLAYER_RE);
      if (playerMatch) {
        const [, levelClass, name, race, guild] = playerMatch;
        let level = null, cls = null;
        if (levelClass !== 'ANONYMOUS') {
          const parts = levelClass.split(' ');
          level = parseInt(parts[0], 10) || null;
          cls   = parts.slice(1).join(' ') || null;
        }
        whoPlayers.push({ name, level, class: cls, race: race || null, guild: guild || null });
      }
      continue;
    }

    // Loot — only during raid window in an approved zone
    if (!isInRaidWindow(utcTs) || !isApprovedZone(currentZone)) continue;

    const session = getSession(utcTs);
    session.zones.add(currentZone);

    const selfLoot = content.match(SELF_LOOT_RE);
    if (selfLoot && characterName) {
      session.loot.push({ playerName: characterName, itemName: selfLoot[1], timestamp: utcTs, zone: currentZone });
      continue;
    }

    const otherLoot = content.match(OTHER_LOOT_RE);
    if (otherLoot) {
      session.loot.push({ playerName: otherLoot[1], itemName: otherLoot[2], timestamp: utcTs, zone: currentZone });
    }
  }

  // Flatten, filter empties, sort by date
  const sessions = Array.from(sessionMap.values())
    .filter(s => s.attendanceMap.size > 0 || s.loot.length > 0)
    .map(s => ({
      date:       s.date,
      dayName:    s.dayName,
      zones:      [...s.zones],
      attendance: [...s.attendanceMap.values()],
      loot:       s.loot,
      firstSeen:  s.firstSeen,
      lastSeen:   s.lastSeen,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return { sessions, lineCount };
}

module.exports = { parseLog, parseEQDate, parseEQDateUTC, normalizeZone, autoParseLog, APPROVED_ZONES };
