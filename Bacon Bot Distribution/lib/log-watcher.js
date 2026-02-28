'use strict';

const fs = require('fs');
const { EventEmitter } = require('events');
const { parseEQDateUTC } = require('./parser');

// Duplicated from parser.js (not exported individually)
const LINE_RE        = /^\[(\w{3} \w{3} +\d{1,2} \d{2}:\d{2}:\d{2} \d{4})\] (.*)$/;
const ZONE_ENTRY_RE  = /^You have entered (.+)\.$/;
const WHO_FOOTER_RE  = /^There are \d+ players in (.+)\.$/;
const WHO_PLAYER_RE  = /^\[(\d+ [^\]]+|ANONYMOUS)\] ([\w`'-]+)(?:\s+\(([^)]+)\))?(?:\s+<([^>]+)>)?/;
const SELF_LOOT_RE   = /^--You have looted a (.+?)\.--$/;
const OTHER_LOOT_RE  = /^--([\w`'-]+) has looted a (.+?)\.--$/;

function normalizeZone(name) {
  return name.toLowerCase().replace(/^the\s+/, '').trim();
}

function zoneMatchesFilters(zoneName, filters) {
  if (!zoneName || !filters.length) return false;
  const norm = normalizeZone(zoneName);
  return filters.some(f => norm.includes(f) || f.includes(norm));
}

class LogWatcher extends EventEmitter {
  constructor({ filePath, timezone, characterName, approvedZones, raidDays, raidStartUTC, raidEndUTC }) {
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

    // Filtering
    this.approvedZoneFilters = (approvedZones || []).map(normalizeZone);
    this.raidDays            = new Set(raidDays || [0, 3, 5, 6]);
    this.raidStartUTC        = raidStartUTC ?? 13;
    this.raidEndUTC          = raidEndUTC ?? 17;
  }

  _isInRaidWindow(utcDate) {
    const h = utcDate.getUTCHours();
    return this.raidDays.has(utcDate.getUTCDay()) &&
           h >= this.raidStartUTC && h < this.raidEndUTC;
  }

  _isApprovedZone(zoneName) {
    return !!zoneName && zoneMatchesFilters(zoneName, this.approvedZoneFilters);
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

    // /who block start — only process if in raid window
    if (content === 'Players on EverQuest:') {
      if (this._isInRaidWindow(utcTs)) {
        this.inWhoBlock  = true;
        this.whoBlockUTC = utcTs;
        this.whoPlayers  = [];
      }
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
          const key = p.name.toLowerCase();
          const existing = this.attendanceMap.get(key);
          if (!existing) {
            this.attendanceMap.set(key, { ...p, firstSeen: this.whoBlockUTC, lastSeen: this.whoBlockUTC });
            newPlayers.push(p);
          } else {
            if (this.whoBlockUTC > existing.lastSeen) existing.lastSeen = this.whoBlockUTC;
          }
        }

        this.emit('attendance', {
          zone:       whoZone,
          total:      this.attendanceMap.size,
          newPlayers,
          allPlayers: Array.from(this.attendanceMap.keys()),
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

    // Loot — only during raid window in an approved zone
    if (!this._isInRaidWindow(utcTs) || !this._isApprovedZone(this.currentZone)) return;

    // Loot — self
    const selfLoot = content.match(SELF_LOOT_RE);
    if (selfLoot && this.characterName) {
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
    const dateStr = firstSeen.toISOString().slice(0, 10);
    const dayNames = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];

    return {
      date:       dateStr,
      dayName:    dayNames[firstSeen.getUTCDay()],
      zones:      [...this.zones],
      attendance,
      loot:       this.lootEvents,
      firstSeen:  firstSeen.toISOString(),
      lastSeen:   lastSeen.toISOString(),
    };
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
