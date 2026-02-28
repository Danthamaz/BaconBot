'use strict';

require('dotenv').config();

const http     = require('http');
const https    = require('https');
const fs       = require('fs');
const path     = require('path');
const { autoParseLog, APPROVED_ZONES } = require('./lib/parser');

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
    res.writeHead(200, { 'Content-Type': MIME[ext] || 'application/octet-stream' });
    res.end(data);
  });
}

// ── Request body reader ─────────────────────────────────────────────────────

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
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

let liveWatcher = null;
let liveClients = [];

// ── Route handler ───────────────────────────────────────────────────────────

async function handleRequest(req, res) {
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
      const body = JSON.parse(await readBody(req));
      const cfg = loadConfig();
      if (body.character !== undefined)     cfg.character     = body.character;
      if (body.timezone !== undefined)      cfg.timezone      = body.timezone;
      if (body.eqFolder !== undefined)      cfg.eqFolder      = body.eqFolder;
      if (body.raidDays !== undefined)      cfg.raidDays      = body.raidDays;
      if (body.raidStartUTC !== undefined)  cfg.raidStartUTC  = body.raidStartUTC;
      if (body.raidEndUTC !== undefined)    cfg.raidEndUTC    = body.raidEndUTC;
      if (body.approvedZones !== undefined) cfg.approvedZones = body.approvedZones;
      saveConfig(cfg);
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
      if (!apiKey) return json(500, { error: 'API_KEY not configured in .env' });

      const body = JSON.parse(await readBody(req));
      const { session, character } = body;
      const zoneStr  = session.zones.join(', ');
      const autoName = `${session.date} ${session.dayName} - ${session.zones.slice(0, 2).join(', ')}`;

      // Check for existing raid
      let existingRaid = null;
      try {
        const lookup = await apiGet(`${serverUrl}/raid?date=${session.date}`, apiKey);
        if (lookup.status === 200) existingRaid = lookup.body.raid;
      } catch { /* server unreachable — will surface on submit */ }

      let result;
      if (existingRaid) {
        result = await apiPost(`${serverUrl}/raid/merge?id=${existingRaid.id}`, {
          attendance: session.attendance,
          loot:       session.loot,
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
          attendance: session.attendance,
          loot:       session.loot,
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

    // ── GET /api/live (SSE) ─────────────────────────────────────
    if (req.method === 'GET' && route === '/api/live') {
      const file     = url.searchParams.get('file');
      const timezone = url.searchParams.get('timezone');
      const character = url.searchParams.get('character');
      if (!file || !timezone) return json(400, { error: 'file and timezone required' });

      sseHeaders(res);

      // If no watcher running, start one
      if (!liveWatcher) {
        const cfg = loadConfig();
        const LogWatcher = require('./lib/log-watcher');
        liveWatcher = new LogWatcher({
          filePath: file, timezone, characterName: character || null,
          approvedZones: cfg.approvedZones,
          raidDays:      cfg.raidDays,
          raidStartUTC:  cfg.raidStartUTC,
          raidEndUTC:    cfg.raidEndUTC,
        });

        liveWatcher.on('zone', data => {
          liveClients.forEach(c => sseSend(c, 'zone', data));
        });
        liveWatcher.on('attendance', data => {
          liveClients.forEach(c => sseSend(c, 'attendance', data));
        });
        liveWatcher.on('loot', data => {
          liveClients.forEach(c => sseSend(c, 'loot', data));
        });
        liveWatcher.on('error', data => {
          liveClients.forEach(c => sseSend(c, 'error', data));
        });

        liveWatcher.start();
      }

      liveClients.push(res);
      sseSend(res, 'started', { file });

      req.on('close', () => {
        liveClients = liveClients.filter(c => c !== res);
      });
      return;
    }

    // ── POST /api/live/stop ─────────────────────────────────────
    if (req.method === 'POST' && route === '/api/live/stop') {
      if (liveWatcher) {
        liveWatcher.stop();
        liveWatcher = null;
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

// ── Start server ────────────────────────────────────────────────────────────

const server = http.createServer(handleRequest);

server.listen(PORT, () => {
  console.log(`\n  BaconBot Web App running at http://localhost:${PORT}\n`);
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
