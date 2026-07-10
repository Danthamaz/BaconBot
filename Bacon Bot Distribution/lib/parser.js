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
const WHO_FOOTER_RE = /^There (?:are|is) \d+ players? in (.+)\.$/;

// /who player line: [60 Virtuoso] Lyri (Vah Shir) <Intervention>
// Also handles: [ANONYMOUS] Lyri  <Intervention>
const WHO_PLAYER_RE = /^\[(\d+ [^\]]+|ANONYMOUS)\] ([\w`'-]+)(?:\s+\(([^)]+)\))?(?:\s+<([^>]+)>)?/;

// Loot events
const SELF_LOOT_RE  = /^--You have looted an? (.+?)\s*\.--$/;
const OTHER_LOOT_RE = /^--([\w`'-]+) has looted an? (.+?)\s*\.--$/;

// --- Month lookup for manual timestamp parsing ---
const MONTHS = {
  Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5,
  Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11,
};

/**
 * Normalize a zone name for fuzzy comparison:
 * strips leading "The ", lowercases, removes hyphens/apostrophes/spaces, trims.
 */
function normalizeZone(name) {
  return name.toLowerCase().replace(/^the\s+/, '').replace(/[-'\s]/g, '').trim();
}

/**
 * Damerau-Levenshtein edit distance (substitution/insertion/deletion +
 * adjacent transposition). Used to tolerate EQ's minor zone-name spelling
 * drift between the zone-entry message and the /who footer — e.g. entry
 * "Kael Drakkel" vs /who "Kael Drakkal", or the "Grieg's"/"Greig's" swap.
 */
function damerauLevenshtein(a, b) {
  const la = a.length, lb = b.length;
  const d = Array.from({ length: la + 1 }, () => new Array(lb + 1).fill(0));
  for (let i = 0; i <= la; i++) d[i][0] = i;
  for (let j = 0; j <= lb; j++) d[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
      }
    }
  }
  return d[la][lb];
}

/**
 * Check whether a zone name matches any of the user-supplied filters.
 * Uses case-insensitive substring matching in both directions so that
 * "fungus" matches "Fungus Grove" and vice versa, plus a 1-edit fuzzy
 * fallback (only for names >= 6 chars, to stay unambiguous) that absorbs
 * EQ's inconsistent zone spellings so attendance isn't silently dropped.
 */
function zoneMatchesFilters(zoneName, filters) {
  if (!zoneName || !filters.length) return false;
  const norm = normalizeZone(zoneName);
  return filters.some(f =>
    norm.includes(f) || f.includes(norm) ||
    (Math.min(norm.length, f.length) >= 6 && damerauLevenshtein(norm, f) <= 1),
  );
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
  "Grieg's End", 'Acrylia Caverns', 'Ssraeshza Temple', 'Umbral Plains',
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

  let h = parts.hour;
  let rollDay = 0;
  if (h === 24) { h = 0; rollDay = 1; }
  const utcBase = new Date(Date.UTC(parts.year, parts.month - 1, parts.day, h, parts.minute, parts.second));
  if (rollDay) utcBase.setUTCDate(utcBase.getUTCDate() + 1);
  const localViewUTC = utcBase.getTime();
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
    if (onProgress && lineCount % 50000 === 0) onProgress(lineCount, fileStream.bytesRead);

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

module.exports = {
  LINE_RE, ZONE_ENTRY_RE, WHO_FOOTER_RE, WHO_PLAYER_RE, SELF_LOOT_RE, OTHER_LOOT_RE,
  parseEQDateUTC, normalizeZone, zoneMatchesFilters, autoParseLog, APPROVED_ZONES,
};
