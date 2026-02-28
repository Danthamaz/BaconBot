'use strict';

/**
 * Minimal HTTP API server for receiving locally-parsed raid data.
 * Only starts if API_KEY is set in .env.
 *
 * Endpoints:
 *   POST /raid            — save a new raid
 *   POST /raid/merge      — merge into an existing raid (requires ?id=<raidId>)
 *   GET  /voice-members   — list members currently in the raid voice channel
 */

const http = require('http');
const { saveRaid, mergeIntoRaid, getRaid, getRaidByDate, getCharacterByDiscordId } = require('./db');

let _client = null;

const PORT    = parseInt(process.env.API_PORT || '3001', 10);
const API_KEY = process.env.API_KEY || null;

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end',  () => resolve(body));
    req.on('error', reject);
  });
}

function send(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

function start(client) {
  _client = client || null;
  if (!API_KEY) {
    console.warn('[API] API_KEY not set — local parse endpoint disabled.');
    return;
  }

  const server = http.createServer(async (req, res) => {
    // Auth
    if (req.headers['x-api-key'] !== API_KEY) {
      return send(res, 401, { error: 'Unauthorized' });
    }

    // GET /raid?date=YYYY-MM-DD — look up existing raid for a date
    if (req.method === 'GET' && req.url.startsWith('/raid')) {
      const date = new URL(req.url, 'http://x').searchParams.get('date');
      if (!date) return send(res, 400, { error: 'Missing date parameter' });
      const raid = getRaidByDate(date);
      return send(res, 200, { raid: raid ?? null });
    }

    // POST /raid — new raid
    if (req.method === 'POST' && req.url === '/raid') {
      try {
        const { raid, attendance, loot } = JSON.parse(await readBody(req));
        const raidId = saveRaid({
          name:          raid.name,
          zone:          raid.zone,
          startTime:     new Date(raid.startTime),
          endTime:       new Date(raid.endTime),
          characterName: raid.characterName || null,
          submittedBy:   raid.submittedBy   || 'local-script',
          attendance:    hydrateDates(attendance),
          loot:          hydrateDates(loot),
        });
        console.log(`[API] New raid saved — ID ${raidId} (${raid.name})`);
        return send(res, 200, { raidId });
      } catch (err) {
        console.error('[API] /raid error:', err.message);
        return send(res, 400, { error: err.message });
      }
    }

    // POST /raid/merge?id=<raidId> — merge into existing
    if (req.method === 'POST' && req.url.startsWith('/raid/merge')) {
      try {
        const raidId = parseInt(new URL(req.url, 'http://x').searchParams.get('id'), 10);
        if (!raidId || !getRaid(raidId)) {
          return send(res, 404, { error: `Raid ${raidId} not found` });
        }
        const { attendance, loot } = JSON.parse(await readBody(req));
        const result = mergeIntoRaid(raidId, {
          attendance: hydrateDates(attendance),
          loot:       hydrateDates(loot),
        });
        console.log(`[API] Merged into raid ${raidId} — ${result.newLoot} new loot rows`);
        return send(res, 200, { raidId, ...result });
      } catch (err) {
        console.error('[API] /raid/merge error:', err.message);
        return send(res, 400, { error: err.message });
      }
    }

    // GET /voice-members — current raid voice channel members
    if (req.method === 'GET' && req.url.startsWith('/voice-members')) {
      const raidVoiceChannelId = process.env.RAID_VOICE_CHANNEL_ID;
      if (!raidVoiceChannelId || !_client) {
        return send(res, 503, { error: 'Voice tracking not available' });
      }

      try {
        const guild = _client.guilds.cache.first();
        if (!guild) return send(res, 503, { error: 'No guild available' });

        const inChannel = guild.voiceStates.cache.filter(vs => vs.channelId === raidVoiceChannelId);
        const members = [];
        for (const [userId, voiceState] of inChannel) {
          const member = voiceState.member ?? await guild.members.fetch(userId).catch(() => null);
          const charName = getCharacterByDiscordId(userId);
          members.push({
            discordId:   userId,
            displayName: member ? member.displayName : userId,
            character:   charName || null,
          });
        }
        return send(res, 200, { members });
      } catch (err) {
        console.error('[API] /voice-members error:', err.message);
        return send(res, 500, { error: err.message });
      }
    }

    return send(res, 404, { error: 'Not found' });
  });

  server.listen(PORT, () => {
    console.log(`[API] Local parse endpoint listening on port ${PORT}`);
  });
}

/** Convert ISO date strings back to Date objects in attendance/loot arrays. */
function hydrateDates(rows) {
  return rows.map(r => {
    const out = { ...r };
    if (out.firstSeen)  out.firstSeen  = new Date(out.firstSeen);
    if (out.lastSeen)   out.lastSeen   = new Date(out.lastSeen);
    if (out.timestamp)  out.timestamp  = new Date(out.timestamp);
    return out;
  });
}

module.exports = { start };
