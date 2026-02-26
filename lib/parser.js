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

module.exports = { parseLog, parseEQDate, normalizeZone };
