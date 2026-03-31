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
const { saveRaid, mergeIntoRaid, getRaid, getRaidByDate, getCharacterByDiscordId, getCharsForDiscordId, linkCharacter, getDiscordInfoForChar, getAllAliases } = require('./db');

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
          const characters = getCharsForDiscordId(userId);
          members.push({
            discordId:   userId,
            displayName: member ? member.displayName : userId,
            character:   characters[0] || null,
            characters:  characters,
          });
        }
        return send(res, 200, { members });
      } catch (err) {
        console.error('[API] /voice-members error:', err.message);
        return send(res, 500, { error: err.message });
      }
    }

    // POST /link-character — link a character to a discord user
    if (req.method === 'POST' && req.url === '/link-character') {
      try {
        const { characterName, discordId, discordTag } = JSON.parse(await readBody(req));
        if (!characterName || !discordId || !discordTag) {
          return send(res, 400, { error: 'characterName, discordId, and discordTag required' });
        }
        linkCharacter(characterName, discordId, discordTag);
        console.log(`[API] Linked "${characterName}" to ${discordTag} (${discordId})`);
        return send(res, 200, { ok: true });
      } catch (err) {
        console.error('[API] /link-character error:', err.message);
        return send(res, 400, { error: err.message });
      }
    }

    // GET /character-info?name=X — get discord info for a character
    if (req.method === 'GET' && req.url.startsWith('/character-info')) {
      const name = new URL(req.url, 'http://x').searchParams.get('name');
      if (!name) return send(res, 400, { error: 'name required' });
      const info = getDiscordInfoForChar(name);
      return send(res, 200, { linked: !!info, ...info });
    }

    // GET /all-linked — return all linked character names
    if (req.method === 'GET' && req.url === '/all-linked') {
      const aliases = getAllAliases();
      const chars = [];
      for (const a of aliases) {
        for (const c of a.characters.split(', ')) chars.push(c.toLowerCase());
      }
      return send(res, 200, { characters: chars });
    }

    // POST /alert — send an alert to the alert channel
    if (req.method === 'POST' && req.url === '/alert') {
      const alertChannelId = process.env.ALERT_CHANNEL_ID;
      if (!alertChannelId || !_client) {
        return send(res, 503, { error: 'Alert channel not configured' });
      }
      try {
        const { itemName, playerName, zone, timestamp } = JSON.parse(await readBody(req));
        const guild = _client.guilds.cache.first();
        if (!guild) return send(res, 503, { error: 'No guild available' });
        const channel = guild.channels.cache.get(alertChannelId);
        if (!channel) return send(res, 503, { error: 'Alert channel not found' });

        const { EmbedBuilder } = require('discord.js');
        const embed = new EmbedBuilder()
          .setTitle('Valuable Item Looted')
          .setColor(0xFFAB00)
          .addFields(
            { name: 'Item', value: itemName || 'Unknown', inline: true },
            { name: 'Looted By', value: playerName || 'Unknown', inline: true },
            { name: 'Zone', value: zone || 'Unknown', inline: true },
          )
          .setTimestamp(timestamp ? new Date(timestamp) : new Date());

        await channel.send({ embeds: [embed] });
        return send(res, 200, { ok: true });
      } catch (err) {
        console.error('[API] /alert error:', err.message);
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
