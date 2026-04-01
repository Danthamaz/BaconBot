'use strict';

require('dotenv').config();

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { autoParseLog, APPROVED_ZONES } = require('./lib/parser');
const quarmDb = require('./lib/quarm-db');

// ── Config ──────────────────────────────────────────────────────────────────

const CONFIG_FILE = path.join(__dirname, 'config.json');
const PORT        = parseInt(process.env.WEB_PORT, 10) || 3456;
const serverUrl   = process.env.SERVER_URL || 'http://129.146.142.5:3001';
const apiKey      = process.env.API_KEY;

const DEFAULT_CONFIG = {
  character:    '',
  timezone:     'America/Phoenix',
  eqFolder:     '',
  raidDays:     [0, 3, 5, 6],        // Sun=0, Wed=3, Fri=5, Sat=6
  raidStartUTC: 13,
  raidEndUTC:   17,
  approvedZones: [...APPROVED_ZONES],
  ignoredItems:  [],
  eqDbPath: '',
  starredItems: [],
};

function loadConfig() {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {
    cfg = {};
  }
  // Merge with defaults so new fields are always present
  return { ...DEFAULT_CONFIG, ...cfg };
}

function saveConfig(cfg) {
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2));
}

// ── HTTP helpers (proxy to bot server) ──────────────────────────────────────

function apiGet(url, key) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname + parsed.search,
      method:   'GET',
      headers:  { 'x-api-key': key },
    };
    const client = url.startsWith('https') ? https : http;
    const req = client.request(opts, res => {
      let resp = '';
      res.on('data', c => { resp += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(resp) }); }
        catch { resolve({ status: res.statusCode, body: resp }); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(new Error('Request timeout')); });
    req.on('error', reject);
    req.end();
  });
}

function apiPost(url, body, key) {
  return new Promise((resolve, reject) => {
    const data   = JSON.stringify(body);
    const parsed = new URL(url);
    const opts = {
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length':  Buffer.byteLength(data),
        'x-api-key':      key,
      },
    };
    const client = url.startsWith('https') ? https : http;
    const req = client.request(opts, res => {
      let resp = '';
      res.on('data', c => { resp += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(resp) }); }
        catch { resolve({ status: res.statusCode, body: resp }); }
      });
    });
    req.setTimeout(10000, () => { req.destroy(new Error('Request timeout')); });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Static file serving ─────────────────────────────────────────────────────

const MIME = {
  '.html': 'text/html',
  '.css':  'text/css',
  '.js':   'application/javascript',
  '.json': 'application/json',
  '.png':  'image/png',
  '.svg':  'image/svg+xml',
  '.ico':  'image/x-icon',
};

function serveStatic(req, res) {
  let filePath = path.join(__dirname, 'public', req.url === '/' ? 'index.html' : req.url);
  filePath = path.normalize(filePath);

  // Prevent directory traversal
  if (!filePath.startsWith(path.join(__dirname, 'public'))) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  const ext = path.extname(filePath);
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache, no-store, must-revalidate',
    });
    res.end(data);
  });
}

// ── Request body reader ─────────────────────────────────────────────────────

function readBody(req, maxSize = 1024 * 1024) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > maxSize) { req.destroy(); reject(new Error('Request body too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString()));
    req.on('error', reject);
  });
}

// ── SSE helper ──────────────────────────────────────────────────────────────

function sseHeaders(res) {
  res.writeHead(200, {
    'Content-Type':  'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection':    'keep-alive',
  });
}

function sseSend(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

// ── Live watcher state ──────────────────────────────────────────────────────

let liveWatcher  = null;
let liveClients  = [];
let liveDevMode  = false;
let autoSaveTimer = null;
const AUTO_SAVE_INTERVAL = 5 * 60 * 1000; // 5 minutes
const SESSION_FILE = path.join(__dirname, 'live-session.json');

function saveSessionToFile() {
  if (!liveWatcher) return;
  try {
    const session = liveWatcher.getSessionData();
    const state = {
      timestamp: new Date().toISOString(),
      currentZone: liveWatcher.currentZone,
      raidEndTime: liveWatcher.raidEndTime ? liveWatcher.raidEndTime.toISOString() : null,
      attendanceMap: Array.from(liveWatcher.attendanceMap.entries()).map(([key, data]) => [key, {
        ...data,
        firstSeen: data.firstSeen ? data.firstSeen.toISOString() : null,
        lastSeen: data.lastSeen ? data.lastSeen.toISOString() : null,
        exitTime: data.exitTime ? data.exitTime.toISOString() : null,
      }]),
      lootEvents: liveWatcher.lootEvents.map(l => ({
        ...l,
        timestamp: l.timestamp instanceof Date ? l.timestamp.toISOString() : l.timestamp,
      })),
      zones: [...liveWatcher.zones],
    };
    fs.writeFileSync(SESSION_FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[session] Failed to save:', err.message);
  }
}

function clearSessionFile() {
  try { fs.unlinkSync(SESSION_FILE); } catch {}
}

async function autoSaveLiveSession() {
  if (!liveWatcher || !apiKey) return;
  const session = liveWatcher.getSessionData();
  if (session.attendance.length === 0 && session.loot.length === 0) return;

  const cfg     = loadConfig();
  const zoneStr  = session.zones.join(', ');
  const autoName = `${session.date} ${session.dayName} - ${session.zones.slice(0, 2).join(', ')}`;

  // Apply awardedTo overrides to loot
  const loot = session.loot.map(l => ({
    ...l,
    playerName: l.awardedTo || l.playerName,
  }));

  // Filter attendance to only validated + linked players
  let attendance = session.attendance;
  try {
    const voiceResult = await apiGet(`${serverUrl}/voice-members`, apiKey);
    if (voiceResult.status === 200 && voiceResult.body.members) {
      const linkedChars = new Set();
      for (const vm of voiceResult.body.members) {
        const chars = vm.characters || (vm.character ? [vm.character] : []);
        for (const ch of chars) linkedChars.add(ch.toLowerCase());
      }
      attendance = attendance.filter(a => a.validated && linkedChars.has(a.name.toLowerCase()));
    }
  } catch {}
  if (attendance.length === 0 && loot.length === 0) return;

  try {
    let existingRaid = null;
    try {
      const lookup = await apiGet(`${serverUrl}/raid?date=${session.date}`, apiKey);
      if (lookup.status === 200) existingRaid = lookup.body.raid;
    } catch {}

    let result;
    if (existingRaid) {
      result = await apiPost(`${serverUrl}/raid/merge?id=${existingRaid.id}`, {
        attendance,
        loot,
      }, apiKey);
    } else {
      result = await apiPost(`${serverUrl}/raid`, {
        raid: {
          name:          autoName,
          zone:          zoneStr,
          startTime:     session.firstSeen,
          endTime:       session.lastSeen,
          characterName: cfg.character || null,
          submittedBy:   'web-app-autosave',
        },
        attendance,
        loot,
      }, apiKey);
    }

    const ok = result.status === 200;
    const raidId = ok ? (result.body.raidId || existingRaid?.id) : null;
    liveClients.forEach(c => sseSend(c, 'autosave', {
      success: ok,
      raidId,
      timestamp: new Date().toISOString(),
    }));
  } catch (err) {
    liveClients.forEach(c => sseSend(c, 'autosave', {
      success: false,
      error: err.message,
      timestamp: new Date().toISOString(),
    }));
  }
  saveSessionToFile();
}

function startAutoSave() {
  stopAutoSave();
  autoSaveTimer = setInterval(autoSaveLiveSession, AUTO_SAVE_INTERVAL);
}

function stopAutoSave() {
  if (autoSaveTimer) { clearInterval(autoSaveTimer); autoSaveTimer = null; }
}

// ── Route handler ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
  // Any request from the browser resets the shutdown timer
  lastHeartbeat = Date.now();

  const url = new URL(req.url, `http://${req.headers.host}`);
  const route = url.pathname;

  // CORS-friendly JSON response helper
  const json = (status, data) => {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  };

  try {
    // ── GET /api/config ─────────────────────────────────────────
    if (req.method === 'GET' && route === '/api/config') {
      const cfg = loadConfig();
      return json(200, cfg);
    }

    // ── POST /api/config ────────────────────────────────────────
    if (req.method === 'POST' && route === '/api/config') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'Invalid JSON' }); }
      const cfg = loadConfig();
      if (body.character !== undefined)     cfg.character     = body.character;
      if (body.timezone !== undefined)      cfg.timezone      = body.timezone;
      if (body.eqFolder !== undefined)      cfg.eqFolder      = body.eqFolder;
      if (body.raidDays !== undefined)      cfg.raidDays      = body.raidDays;
      if (body.raidStartUTC !== undefined)  cfg.raidStartUTC  = body.raidStartUTC;
      if (body.raidEndUTC !== undefined)    cfg.raidEndUTC    = body.raidEndUTC;
      if (body.approvedZones !== undefined) cfg.approvedZones = body.approvedZones;
      if (body.ignoredItems !== undefined)  cfg.ignoredItems  = body.ignoredItems;
      if (body.eqDbPath !== undefined)      cfg.eqDbPath      = body.eqDbPath;
      if (body.starredItems !== undefined)  cfg.starredItems  = body.starredItems;
      saveConfig(cfg);
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
      return json(200, { ok: true });
    }

    // ── GET /api/detect-log ─────────────────────────────────────
    if (req.method === 'GET' && route === '/api/detect-log') {
      const character = url.searchParams.get('character');
      const eqFolder  = url.searchParams.get('eqFolder');
      if (!character || !eqFolder) return json(400, { error: 'character and eqFolder required' });

      const pattern = `eqlog_${character}_`;
      let found = null;
      try {
        const files = fs.readdirSync(eqFolder);
        for (const f of files) {
          if (f.startsWith(pattern) && f.endsWith('.txt')) {
            found = path.join(eqFolder, f);
            break;
          }
        }
      } catch (err) {
        return json(400, { error: `Cannot read folder: ${err.message}` });
      }
      if (found) return json(200, { file: found });
      return json(404, { error: `No log file matching eqlog_${character}_*.txt` });
    }

    // ── GET /api/parse (SSE) ────────────────────────────────────
    if (req.method === 'GET' && route === '/api/parse') {
      const file      = url.searchParams.get('file');
      const timezone  = url.searchParams.get('timezone');
      const character = url.searchParams.get('character');
      if (!file || !timezone) return json(400, { error: 'file and timezone required' });

      sseHeaders(res);

      let fileSize = 0;
      try { fileSize = fs.statSync(file).size; } catch {}

      let lastReport = Date.now();
      try {
        const { sessions, lineCount } = await autoParseLog({
          filePath:      file,
          timezone,
          characterName: character || null,
          onProgress: (lines, bytesRead) => {
            const now = Date.now();
            if (now - lastReport > 500) {
              lastReport = now;
              const pct = fileSize > 0 ? Math.min(99, Math.round((bytesRead / fileSize) * 100)) : 0;
              sseSend(res, 'progress', { pct, lines, mb: (bytesRead / 1024 / 1024).toFixed(1) });
            }
          },
        });

        sseSend(res, 'complete', { sessions, lineCount, approvedZones: APPROVED_ZONES });
      } catch (err) {
        sseSend(res, 'error', { message: err.message });
      }
      res.end();
      return;
    }

    // ── POST /api/submit ────────────────────────────────────────
    if (req.method === 'POST' && route === '/api/submit') {
      if (liveDevMode) return json(200, { action: 'dev-mode', message: 'Skipped — dev mode active' });
      if (!apiKey) return json(500, { error: 'API_KEY not configured in .env' });

      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'Invalid JSON' }); }
      const { session, character } = body;
      const zoneStr  = session.zones.join(', ');
      const autoName = `${session.date} ${session.dayName} - ${session.zones.slice(0, 2).join(', ')}`;

      // Apply awardedTo overrides to loot
      const loot = session.loot.map(l => ({
        ...l,
        playerName: l.awardedTo || l.playerName,
      }));

      // Filter attendance to only validated + linked players
      let attendance = session.attendance;
      try {
        const voiceResult = await apiGet(`${serverUrl}/voice-members`, apiKey);
        if (voiceResult.status === 200 && voiceResult.body.members) {
          const linkedChars = new Set();
          for (const vm of voiceResult.body.members) {
            const chars = vm.characters || (vm.character ? [vm.character] : []);
        for (const ch of chars) linkedChars.add(ch.toLowerCase());
          }
          attendance = attendance.filter(a => a.validated && linkedChars.has(a.name.toLowerCase()));
        }
      } catch {}

      // Check for existing raid
      let existingRaid = null;
      try {
        const lookup = await apiGet(`${serverUrl}/raid?date=${session.date}`, apiKey);
        if (lookup.status === 200) existingRaid = lookup.body.raid;
      } catch { /* server unreachable — will surface on submit */ }

      let result;
      if (existingRaid) {
        result = await apiPost(`${serverUrl}/raid/merge?id=${existingRaid.id}`, {
          attendance,
          loot,
        }, apiKey);
        if (result.status === 200) {
          return json(200, { action: 'merged', raidId: existingRaid.id, newLoot: result.body.newLoot });
        }
      } else {
        result = await apiPost(`${serverUrl}/raid`, {
          raid: {
            name:          autoName,
            zone:          zoneStr,
            startTime:     session.firstSeen,
            endTime:       session.lastSeen,
            characterName: character || null,
            submittedBy:   'web-app',
          },
          attendance,
          loot,
        }, apiKey);
        if (result.status === 200) {
          return json(200, { action: 'created', raidId: result.body.raidId });
        }
      }
      return json(result.status || 500, { error: result.body });
    }

    // ── GET /api/check-raid ─────────────────────────────────────
    if (req.method === 'GET' && route === '/api/check-raid') {
      if (!apiKey) return json(500, { error: 'API_KEY not configured in .env' });
      const date = url.searchParams.get('date');
      if (!date) return json(400, { error: 'date required' });

      try {
        const result = await apiGet(`${serverUrl}/raid?date=${date}`, apiKey);
        return json(result.status, result.body);
      } catch (err) {
        return json(502, { error: err.message });
      }
    }

    // ── GET /api/voice-members ─────────────────────────────────
    if (req.method === 'GET' && route === '/api/voice-members') {
      if (!apiKey) return json(500, { error: 'API_KEY not configured in .env' });
      try {
        const result = await apiGet(`${serverUrl}/voice-members`, apiKey);
        return json(result.status, result.body);
      } catch (err) {
        return json(502, { error: err.message });
      }
    }

    // ── POST /api/link-character ─────────────────────────────────
    if (req.method === 'POST' && route === '/api/link-character') {
      if (!apiKey) return json(500, { error: 'API_KEY not configured in .env' });
      try {
        let body;
        try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'Invalid JSON' }); }
        const result = await apiPost(`${serverUrl}/link-character`, body, apiKey);
        return json(result.status, result.body);
      } catch (err) {
        return json(502, { error: err.message });
      }
    }

    // ── GET /api/character-info ────────────────────────────────────
    if (req.method === 'GET' && route === '/api/character-info') {
      if (!apiKey) return json(500, { error: 'API_KEY not configured in .env' });
      const name = url.searchParams.get('name');
      if (!name) return json(400, { error: 'name required' });
      try {
        const result = await apiGet(`${serverUrl}/character-info?name=${encodeURIComponent(name)}`, apiKey);
        return json(result.status, result.body);
      } catch (err) {
        return json(502, { error: err.message });
      }
    }

    // ── GET /api/live (SSE) ─────────────────────────────────────
    if (req.method === 'GET' && route === '/api/live') {
      const file     = url.searchParams.get('file');
      const timezone = url.searchParams.get('timezone');
      const character = url.searchParams.get('character');
      const devMode  = url.searchParams.get('devMode') === '1';
      if (!file || !timezone) return json(400, { error: 'file and timezone required' });

      sseHeaders(res);

      // If no watcher running, start one
      if (!liveWatcher) {
        liveDevMode = devMode;
        const cfg = loadConfig();
        const LogWatcher = require('./lib/log-watcher');
        liveWatcher = new LogWatcher({
          filePath: file, timezone, characterName: character || null,
          approvedZones: cfg.approvedZones,
          raidDays:      cfg.raidDays,
          raidStartUTC:  cfg.raidStartUTC,
          raidEndUTC:    cfg.raidEndUTC,
          ignoredItems:  cfg.ignoredItems || [],
          starredItems:  cfg.starredItems || [],
        });

        liveWatcher.on('zone', data => {
          liveClients.forEach(c => sseSend(c, 'zone', data));
        });
        liveWatcher.on('attendance', async data => {
          // Fetch voice members and all linked characters
          let allLinkedChars = new Set();
          try {
            const linkedResult = await apiGet(`${serverUrl}/all-linked`, apiKey);
            if (linkedResult.status === 200 && linkedResult.body.characters) {
              for (const c of linkedResult.body.characters) allLinkedChars.add(c.toLowerCase());
            }
          } catch {}

          try {
            const voiceResult = await apiGet(`${serverUrl}/voice-members`, apiKey);
            if (voiceResult.status === 200 && voiceResult.body.members) {
              const voiceConfirmed = new Set();
              for (const vm of voiceResult.body.members) {
                const chars = vm.characters || (vm.character ? [vm.character] : []);
                for (const ch of chars) voiceConfirmed.add(ch.toLowerCase());
              }
              // Only update lastSeen for players in both /who AND voice
              const whoNames = data.whoPlayers ? new Set(data.whoPlayers) : null;
              liveWatcher.validatePlayers(voiceConfirmed, whoNames);
            }
          } catch {}

          // Re-build the player list after validation (deduped by name with zones)
          const playerMap = new Map();
          for (const [key, d] of liveWatcher.attendanceMap) {
            const lowerName = d.name.toLowerCase();
            const existing = playerMap.get(lowerName);
            if (!existing) {
              playerMap.set(lowerName, {
                name: d.name,
                zones: d.zone ? [d.zone] : [],
                lastSeen: d.lastSeen,
                exitTime: d.exitTime || null,
                validated: !!d.validated,
                inWho: !!d.inWho,
                inVoice: !!d.inVoice,
              });
            } else {
              if (d.zone && !existing.zones.includes(d.zone)) existing.zones.push(d.zone);
              if (d.lastSeen > existing.lastSeen) existing.lastSeen = d.lastSeen;
              if (d.validated) existing.validated = true;
              if (d.inWho) existing.inWho = true;
              if (d.inVoice) existing.inVoice = true;
              if (d.exitTime && (!existing.exitTime || d.exitTime > existing.exitTime)) existing.exitTime = d.exitTime;
            }
          }
          const allPlayersWithTime = Array.from(playerMap.values()).map(p => ({
            name: p.name,
            zones: p.zones,
            lastSeen: p.lastSeen.toISOString(),
            exitTime: p.exitTime ? p.exitTime.toISOString() : null,
            validated: p.validated,
            inWho: p.inWho,
            inVoice: p.inVoice,
            linked: allLinkedChars.has(p.name.toLowerCase()),
          }));
          const updated = { ...data, allPlayers: allPlayersWithTime };
          liveClients.forEach(c => sseSend(c, 'attendance', updated));
          saveSessionToFile();
        });
        liveWatcher.on('loot', data => {
          liveClients.forEach(c => sseSend(c, 'loot', data));
        });
        liveWatcher.on('error', data => {
          liveClients.forEach(c => sseSend(c, 'error', data));
        });
        liveWatcher.on('raid-ended', data => {
          liveClients.forEach(c => sseSend(c, 'raid-ended', data));
        });

        liveWatcher.on('starred-loot', async data => {
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

        // Restore previous session if available
        try {
          if (fs.existsSync(SESSION_FILE)) {
            const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
            const age = Date.now() - new Date(saved.timestamp).getTime();
            if (age < 6 * 60 * 60 * 1000) { // Less than 6 hours old
              liveWatcher.restoreSession(saved);
              console.log(`[session] Restored session from ${saved.timestamp}`);
            } else {
              console.log('[session] Saved session too old, starting fresh');
              clearSessionFile();
            }
          }
        } catch (err) {
          console.error('[session] Failed to restore:', err.message);
        }

        liveWatcher.start();
        if (!liveDevMode) startAutoSave();
      }

      liveClients.push(res);
      sseSend(res, 'started', { file });

      // Replay current state to the connecting client
      // Zone first so attendance event doesn't trigger a zone-change prompt
      if (liveWatcher.currentZone) {
        sseSend(res, 'zone', { zone: liveWatcher.currentZone, timestamp: new Date().toISOString() });
      }

      if (liveWatcher.attendanceMap.size > 0 || liveWatcher.lootEvents.length > 0) {
        console.log(`[replay] Replaying ${liveWatcher.attendanceMap.size} attendance entries, ${liveWatcher.lootEvents.length} loot`);

        // Build deduped attendance for UI
        const playerMap = new Map();
        for (const [key, d] of liveWatcher.attendanceMap) {
          const lowerName = d.name.toLowerCase();
          const existing = playerMap.get(lowerName);
          if (!existing) {
            playerMap.set(lowerName, {
              name: d.name, zones: d.zone ? [d.zone] : [],
              lastSeen: d.lastSeen, exitTime: d.exitTime || null, validated: !!d.validated,
              inWho: !!d.inWho, inVoice: !!d.inVoice,
            });
          } else {
            if (d.zone && !existing.zones.includes(d.zone)) existing.zones.push(d.zone);
            if (d.lastSeen > existing.lastSeen) existing.lastSeen = d.lastSeen;
            if (d.validated) existing.validated = true;
            if (d.inWho) existing.inWho = true;
            if (d.inVoice) existing.inVoice = true;
          }
        }
        const allPlayers = Array.from(playerMap.values()).map(p => ({
          name: p.name, zones: p.zones,
          lastSeen: p.lastSeen instanceof Date ? p.lastSeen.toISOString() : String(p.lastSeen || ''),
          exitTime: p.exitTime ? (p.exitTime instanceof Date ? p.exitTime.toISOString() : String(p.exitTime)) : null,
          validated: p.validated, inWho: p.inWho, inVoice: p.inVoice,
          linked: false,
        }));

        sseSend(res, 'attendance', {
          zone: liveWatcher.currentZone || '',
          total: playerMap.size,
          newPlayers: [],
          allPlayers,
          timestamp: new Date().toISOString(),
        });

        // Replay loot events
        for (const l of liveWatcher.lootEvents) {
          sseSend(res, 'loot', {
            ...l,
            timestamp: l.timestamp instanceof Date ? l.timestamp.toISOString() : l.timestamp,
          });
        }

        // Replay raid end
        if (liveWatcher.raidEndTime) {
          sseSend(res, 'raid-ended', { endTime: liveWatcher.raidEndTime.toISOString() });
        }
      }

      req.on('close', () => {
        liveClients = liveClients.filter(c => c !== res);
      });
      return;
    }

    // ── GET /api/heartbeat ──────────────────────────────────────────
    if (req.method === 'GET' && route === '/api/heartbeat') {
      lastHeartbeat = Date.now();
      return json(200, { ok: true });
    }

    // ── GET /api/session-status ───────────────────────────────────
    if (req.method === 'GET' && route === '/api/session-status') {
      try {
        if (fs.existsSync(SESSION_FILE)) {
          const saved = JSON.parse(fs.readFileSync(SESSION_FILE, 'utf8'));
          const age = Date.now() - new Date(saved.timestamp).getTime();
          if (age < 6 * 60 * 60 * 1000) {
            return json(200, {
              available: true,
              timestamp: saved.timestamp,
              playerCount: saved.attendanceMap ? saved.attendanceMap.length : 0,
              lootCount: saved.lootEvents ? saved.lootEvents.length : 0,
              zones: saved.zones || [],
            });
          }
        }
      } catch {}
      return json(200, { available: false });
    }

    // ── POST /api/live/attendance ────────────────────────────────
    if (req.method === 'POST' && route === '/api/live/attendance') {
      if (!liveWatcher) return json(400, { error: 'Live mode not running' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'Invalid JSON' }); }
      const { name, action } = body;
      if (!name || !action) return json(400, { error: 'name and action required' });

      let ok = false;
      if (action === 'remove') {
        ok = liveWatcher.removePlayer(name);
      } else if (action === 'exit') {
        ok = liveWatcher.markPlayerExited(name);
      } else if (action === 'clear-exit') {
        ok = liveWatcher.clearPlayerExit(name);
      }
      if (!ok) return json(404, { error: 'Player not found' });

      // Broadcast updated attendance list (deduped by name with zones)
      const playerMap = new Map();
      for (const [key, data] of liveWatcher.attendanceMap) {
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
      liveClients.forEach(c => sseSend(c, 'attendance-update', {
        total: liveWatcher.attendanceMap.size,
        allPlayers: allPlayersWithTime,
      }));
      return json(200, { ok: true });
    }

    // ── POST /api/live/loot ─────────────────────────────────────
    if (req.method === 'POST' && route === '/api/live/loot') {
      if (!liveWatcher) return json(400, { error: 'Live mode not running' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'Invalid JSON' }); }
      const { index, awardedTo } = body;
      if (index === undefined) return json(400, { error: 'index is required' });
      const ok = liveWatcher.updateLoot(index, awardedTo || null);
      if (!ok) return json(404, { error: 'Invalid loot index' });
      liveClients.forEach(c => sseSend(c, 'loot-update', { index, awardedTo: awardedTo || null }));
      return json(200, { index, awardedTo: awardedTo || null });
    }

    // ── POST /api/live/ignore-item ─────────────────────────────
    if (req.method === 'POST' && route === '/api/live/ignore-item') {
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'Invalid JSON' }); }
      const itemName = (body.itemName || '').trim();
      if (!itemName) return json(400, { error: 'itemName is required' });

      // Add to config
      const cfg = loadConfig();
      if (!cfg.ignoredItems) cfg.ignoredItems = [];
      const alreadyIgnored = cfg.ignoredItems.some(i => i.toLowerCase() === itemName.toLowerCase());
      if (!alreadyIgnored) {
        cfg.ignoredItems.push(itemName);
        saveConfig(cfg);
      }

      // Update the live watcher's ignore list if running
      if (liveWatcher) {
        liveWatcher.setIgnoredItems(cfg.ignoredItems);
      }

      // Broadcast to all SSE clients so they can hide matching items
      liveClients.forEach(c => sseSend(c, 'item-ignored', { itemName }));
      return json(200, { ok: true, itemName });
    }

    // ── POST /api/live/zone ─────────────────────────────────────
    if (req.method === 'POST' && route === '/api/live/zone') {
      if (!liveWatcher) return json(400, { error: 'Live mode not running' });
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'Invalid JSON' }); }
      const zone = body.zone;
      if (!zone) return json(400, { error: 'zone is required' });
      liveWatcher.setZone(zone);
      return json(200, { zone });
    }

    // ── POST /api/live/end-raid ────────────────────────────────────
    if (req.method === 'POST' && route === '/api/live/end-raid') {
      if (!liveWatcher) return json(400, { error: 'Live mode not running' });
      liveWatcher.setRaidEndTime();
      return json(200, { endTime: liveWatcher.raidEndTime.toISOString() });
    }

    // ── POST /api/live/stop ─────────────────────────────────────
    if (req.method === 'POST' && route === '/api/live/stop') {
      if (liveWatcher) {
        if (!liveDevMode) {
          try { await Promise.race([autoSaveLiveSession(), new Promise(r => setTimeout(r, 5000))]); } catch {}
        }
        stopAutoSave();
        liveWatcher.stop();
        liveWatcher = null;
        liveDevMode = false;
        clearSessionFile();
        liveClients.forEach(c => {
          sseSend(c, 'stopped', {});
          c.end();
        });
        liveClients = [];
      }
      return json(200, { ok: true });
    }

    // ── GET /api/live/session ───────────────────────────────────
    if (req.method === 'GET' && route === '/api/live/session') {
      if (!liveWatcher) return json(404, { error: 'No live session active' });
      return json(200, liveWatcher.getSessionData());
    }

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
      let body;
      try { body = JSON.parse(await readBody(req)); } catch { return json(400, { error: 'Invalid JSON' }); }
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
      if (liveWatcher && liveWatcher.setStarredItems) liveWatcher.setStarredItems(cfg.starredItems);
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

    // ── GET /api/raidtick ─────────────────────────────────────────
    if (req.method === 'GET' && route === '/api/raidtick') {
      const cfg = loadConfig();
      if (!cfg.eqFolder) return json(400, { error: 'eqFolder not configured in Settings' });
      try {
        const files = fs.readdirSync(cfg.eqFolder)
          .filter(f => f.startsWith('RaidTick-') && f.endsWith('.txt'))
          .sort()
          .reverse();
        if (files.length === 0) return json(404, { error: 'No RaidTick files found' });
        const latest = files[0];
        const filePath = path.join(cfg.eqFolder, latest);
        const content = fs.readFileSync(filePath, 'utf8');
        return json(200, { file: latest, content });
      } catch (err) {
        return json(500, { error: err.message });
      }
    }

    // ── Static files ────────────────────────────────────────────
    if (req.method === 'GET' && !route.startsWith('/api/')) {
      return serveStatic(req, res);
    }

    json(404, { error: 'Not found' });
  } catch (err) {
    console.error('Request error:', err);
    json(500, { error: err.message });
  }
}

// ── Auto-shutdown when browser disconnects ──────────────────────────────────

let lastHeartbeat = Date.now();
const SHUTDOWN_TIMEOUT = 60000; // 60 seconds with no heartbeat

setInterval(() => {
  if (Date.now() - lastHeartbeat > SHUTDOWN_TIMEOUT) {
    console.log('\n  No browser connected for 60s — shutting down.\n');
    if (liveWatcher) {
      saveSessionToFile();
      liveWatcher.stop();
    }
    process.exit(0);
  }
}, 10000);

// ── Start server ────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`\n  BaconBot Web App running at http://localhost:${PORT}\n`);
  // Initialize quarm data cache
  const cfg = loadConfig();
  try {
    quarmDb.initCache();
    const hasData = quarmDb.getAllZones().length > 0;

    if (cfg.eqDbPath) {
      // Re-import from SQL dump (maintainer mode)
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
    } else if (hasData) {
      console.log('[quarm-db] Using pre-built cache');
    } else {
      console.log('[quarm-db] No cache data and no eqDbPath configured');
    }
  } catch (err) {
    console.error('[quarm-db] Init failed:', err.message);
  }
}).on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.log(`  Port ${PORT} in use, trying ${PORT + 1}...`);
    server.listen(PORT + 1, () => {
      console.log(`\n  BaconBot Web App running at http://localhost:${PORT + 1}\n`);
    });
  } else {
    console.error('Server error:', err);
    process.exit(1);
  }
});
