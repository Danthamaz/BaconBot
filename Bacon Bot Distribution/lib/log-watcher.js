'use strict';

const fs = require('fs');
const { EventEmitter } = require('events');
const { parseEQDateUTC } = require('./parser');

// Duplicated from parser.js (not exported individually)
const LINE_RE        = /^\[(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\] (.*)$/;
const ZONE_ENTRY_RE  = /^You have entered (.+)\.$/;
const WHO_FOOTER_RE  = /^There are \d+ players in (.+)\.$/;
const WHO_PLAYER_RE  = /^\[(\d+ [^\]]+|ANONYMOUS)\] ([\w`'-]+)(?:\s+\(([^)]+)\))?(?:\s+<([^>]+)>)?/;
const SELF_LOOT_RE   = /^--You have looted an? (.+?)\s*\.--$/;
const OTHER_LOOT_RE  = /^--([\w`'-]+) has looted an? (.+?)\s*\.--$/;

function normalizeZone(name) {
  return name.toLowerCase().replace(/^the\s+/, '').trim();
}

function zoneMatchesFilters(zoneName, filters) {
  if (!zoneName || !filters.length) return false;
  const norm = normalizeZone(zoneName);
  return filters.some(f => norm.includes(f) || f.includes(norm));
}

class LogWatcher extends EventEmitter {
  constructor({ filePath, timezone, characterName, approvedZones, raidDays, raidStartUTC, raidEndUTC, ignoredItems }) {
    super();
    this.filePath      = filePath;
    this.timezone      = timezone;
    this.characterName = characterName;
    this.offset        = 0;
    this.watcher       = null;
    this.pendingChunk  = '';
    this.currentZone   = null;
    this.inWhoBlock    = false;
    this.whoBlockUTC   = null;
    this.whoPlayers    = [];
    this.attendanceMap = new Map();
    this.lootEvents    = [];
    this.zones         = new Set();
    this._debounce     = null;
    this.raidEndTime   = null;

    // Filtering
    this.approvedZoneFilters = (approvedZones || []).map(normalizeZone);
    this.raidDays            = new Set(raidDays || [0, 3, 5, 6]);
    this.raidStartUTC        = raidStartUTC ?? 13;
    this.raidEndUTC          = raidEndUTC ?? 17;
    this.ignoredItems        = new Set((ignoredItems || []).map(i => i.toLowerCase()));
  }

  _isInRaidWindow(utcDate) {
    const h = utcDate.getUTCHours();
    return this.raidDays.has(utcDate.getUTCDay()) &&
           h >= this.raidStartUTC && h < this.raidEndUTC;
  }

  _isApprovedZone(zoneName) {
    return !!zoneName && zoneMatchesFilters(zoneName, this.approvedZoneFilters);
  }

  _isIgnoredItem(itemName) {
    return this.ignoredItems.has(itemName.toLowerCase());
  }

  setRaidEndTime() {
    this.raidEndTime = new Date();
    this.emit('raid-ended', { endTime: this.raidEndTime.toISOString() });
  }

  setIgnoredItems(items) {
    this.ignoredItems = new Set((items || []).map(i => i.toLowerCase()));
  }

  start() {
    try {
      const stat = fs.statSync(this.filePath);
      this.offset = stat.size;
    } catch (err) {
      this.emit('error', { message: `Cannot stat file: ${err.message}` });
      return;
    }

    this.watcher = fs.watch(this.filePath, (eventType) => {
      if (eventType === 'change') {
        // Debounce rapid changes
        if (this._debounce) clearTimeout(this._debounce);
        this._debounce = setTimeout(() => this._readNew(), 100);
      }
    });

    this.watcher.on('error', err => {
      this.emit('error', { message: err.message });
    });
  }

  _readNew() {
    let stat;
    try { stat = fs.statSync(this.filePath); } catch { return; }
    if (stat.size <= this.offset) return;

    const bytesToRead = stat.size - this.offset;
    const buf = Buffer.alloc(bytesToRead);
    let fd;
    try {
      fd = fs.openSync(this.filePath, 'r');
      fs.readSync(fd, buf, 0, bytesToRead, this.offset);
      fs.closeSync(fd);
    } catch (err) {
      if (fd !== undefined) try { fs.closeSync(fd); } catch {}
      return;
    }

    this.offset = stat.size;
    const text = this.pendingChunk + buf.toString('utf8');
    const lines = text.split(/\r?\n/);
    // Last element may be incomplete — save for next read
    this.pendingChunk = lines.pop() || '';

    for (const line of lines) {
      this._processLine(line);
    }
  }

  _processLine(line) {
    const lineMatch = line.match(LINE_RE);
    if (!lineMatch) return;

    const [, tsStr, content] = lineMatch;
    const utcTs = parseEQDateUTC(tsStr, this.timezone);
    if (!utcTs) return;

    // Zone entry
    const zoneEntry = content.match(ZONE_ENTRY_RE);
    if (zoneEntry) {
      this.currentZone = zoneEntry[1];
      this.zones.add(this.currentZone);
      this.inWhoBlock = false;
      this.emit('zone', { zone: this.currentZone, timestamp: utcTs.toISOString() });
      return;
    }

    // /who block start
    if (content === 'Players on EverQuest:') {
      this.inWhoBlock  = true;
      this.whoBlockUTC = utcTs;
      this.whoPlayers  = [];
      return;
    }

    // Inside /who block
    if (this.inWhoBlock) {
      if (content === '---------------------------') return;

      const footerMatch = content.match(WHO_FOOTER_RE);
      if (footerMatch) {
        const whoZone = footerMatch[1];
        this.inWhoBlock = false;

        // Only record attendance if zone is approved
        if (!this._isApprovedZone(whoZone)) return;

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

        const playerMap = new Map();
        for (const [key, data] of this.attendanceMap) {
          const lowerName = data.name.toLowerCase();
          const existing = playerMap.get(lowerName);
          if (!existing) {
            playerMap.set(lowerName, {
              name: data.name,
              zones: data.zone ? [data.zone] : [],
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

        this.emit('attendance', {
          zone:       whoZone,
          total:      this.attendanceMap.size,
          newPlayers,
          allPlayers: allPlayersWithTime,
          timestamp:  this.whoBlockUTC.toISOString(),
        });
        return;
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
        this.whoPlayers.push({ name, level, class: cls, race: race || null, guild: guild || null });
      }
      return;
    }

    // Loot — only in an approved zone
    if (!this._isApprovedZone(this.currentZone)) return;

    // Loot — self
    const selfLoot = content.match(SELF_LOOT_RE);
    if (selfLoot && this.characterName) {
      if (this._isIgnoredItem(selfLoot[1])) return;
      const lootItem = {
        playerName: this.characterName,
        itemName:   selfLoot[1],
        timestamp:  utcTs,
        zone:       this.currentZone,
      };
      this.lootEvents.push(lootItem);
      this.emit('loot', { ...lootItem, timestamp: utcTs.toISOString() });
      return;
    }

    // Loot — other
    const otherLoot = content.match(OTHER_LOOT_RE);
    if (otherLoot) {
      if (this._isIgnoredItem(otherLoot[2])) return;
      const lootItem = {
        playerName: otherLoot[1],
        itemName:   otherLoot[2],
        timestamp:  utcTs,
        zone:       this.currentZone,
      };
      this.lootEvents.push(lootItem);
      this.emit('loot', { ...lootItem, timestamp: utcTs.toISOString() });
    }
  }

  getSessionData() {
    const attendance = Array.from(this.attendanceMap.values());
    const firstSeen = attendance.length > 0
      ? new Date(Math.min(...attendance.map(a => a.firstSeen.getTime())))
      : new Date();
    const lastSeen = attendance.length > 0
      ? new Date(Math.max(...attendance.map(a => a.lastSeen.getTime())))
      : new Date();
    const endTime = this.raidEndTime
      ? this.raidEndTime.toISOString()
      : lastSeen.toISOString();
    const dateStr = firstSeen.toISOString().slice(0, 10);
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    return {
      date:       dateStr,
      dayName:    dayNames[firstSeen.getUTCDay()],
      zones:      [...this.zones],
      attendance,
      loot:       this.lootEvents,
      firstSeen:  firstSeen.toISOString(),
      lastSeen:   endTime,
    };
  }

  /**
   * Update lastSeen only for players confirmed in both zone and voice.
   * @param {Set<string>} voiceConfirmedNames — lowercased character names confirmed in voice
   */
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

  updateLoot(index, awardedTo) {
    if (index < 0 || index >= this.lootEvents.length) return false;
    if (awardedTo) {
      this.lootEvents[index].awardedTo = awardedTo;
    } else {
      delete this.lootEvents[index].awardedTo;
    }
    return true;
  }

  setZone(zoneName) {
    this.currentZone = zoneName;
    this.zones.add(zoneName);
    this.emit('zone', { zone: zoneName, timestamp: new Date().toISOString() });
  }

  stop() {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }
    if (this._debounce) clearTimeout(this._debounce);
  }
}

module.exports = LogWatcher;
