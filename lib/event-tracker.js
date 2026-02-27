'use strict';

/**
 * Discord event-driven raid tracking.
 *
 * Listens for:
 *   - guildScheduledEventUpdate  → creates/finalizes raid rows
 *   - voiceStateUpdate           → tracks who joins/leaves the raid voice channel
 *
 * In-memory state:
 *   activeRaid = { raidId, eventId, members: Map<discordId, { name, firstSeen, lastSeen }> }
 *             or null when no raid is in progress.
 */

const db = require('./db');

let _client             = null;
let raidVoiceChannelId  = null;
let alertChannelId      = null;
let activeRaid          = null;

// ── Initialise (call once inside clientReady) ───────────────────────────────

async function init(client) {
  _client            = client;
  raidVoiceChannelId = process.env.RAID_VOICE_CHANNEL_ID || null;
  alertChannelId     = process.env.ALERT_CHANNEL_ID      || null;

  if (!raidVoiceChannelId) {
    console.log('[EventTracker] RAID_VOICE_CHANNEL_ID not set — voice tracking disabled');
    return;
  }

  // Restore state if the bot restarted while a raid was already in progress.
  for (const guild of client.guilds.cache.values()) {
    try {
      const events      = await guild.scheduledEvents.fetch();
      const activeEvent = events.find(e => e.status === 2); // GuildScheduledEventStatus.Active
      if (!activeEvent) continue;

      const today   = new Date().toISOString().slice(0, 10);
      const raidRow = db.getRaidByDate(today);
      if (raidRow && raidRow.submitted_by === 'discord-event') {
        activeRaid = { raidId: raidRow.id, eventId: activeEvent.id, members: new Map() };
        console.log(`[EventTracker] Restored active raid #${raidRow.id} from DB (event: "${activeEvent.name}")`);
        await snapshotVoiceChannel(guild);
      }
    } catch (err) {
      console.error('[EventTracker] init error:', err);
    }
  }
}

// ── Scheduled-event lifecycle ───────────────────────────────────────────────

async function onScheduledEventUpdate(oldEvent, newEvent) {
  // Status 2 = ACTIVE (event just started)
  if (newEvent.status === 2) {
    const now    = new Date();
    const raidId = db.createRaid({
      name:        newEvent.name,
      zone:        'Discord Event',
      startTime:   now,
      endTime:     now,
      submittedBy: 'discord-event',
    });

    activeRaid = { raidId, eventId: newEvent.id, members: new Map() };
    console.log(`[EventTracker] Event started: "${newEvent.name}" → Raid #${raidId}`);

    if (newEvent.guild) await snapshotVoiceChannel(newEvent.guild);
    return;
  }

  // Status 3 = COMPLETED, 4 = CANCELED
  if ((newEvent.status === 3 || newEvent.status === 4) && activeRaid) {
    const now = new Date();

    for (const [discordId, memberData] of activeRaid.members) {
      if (!memberData.lastSeen) {
        memberData.lastSeen = now;
        db.upsertVoiceAttendance(
          activeRaid.raidId, memberData.name, discordId, memberData.firstSeen, now
        );
      }
    }

    db.updateRaidEndTime(activeRaid.raidId, now);
    console.log(`[EventTracker] Event ended: Raid #${activeRaid.raidId} finalized (${activeRaid.members.size} attendees)`);
    activeRaid = null;
  }
}

// ── Voice channel tracking ──────────────────────────────────────────────────

async function onVoiceStateUpdate(oldState, newState) {
  if (!activeRaid || !raidVoiceChannelId) return;

  const wasInRaid = oldState.channelId === raidVoiceChannelId;
  const isInRaid  = newState.channelId === raidVoiceChannelId;

  if (!wasInRaid && isInRaid) {
    const member = newState.member;
    if (member) await handleJoin(member);
  } else if (wasInRaid && !isInRaid) {
    handleLeave(newState.id);
  }
}

// ── Internal helpers ────────────────────────────────────────────────────────

async function snapshotVoiceChannel(guild) {
  if (!activeRaid || !raidVoiceChannelId) return;
  try {
    const channel = await guild.channels.fetch(raidVoiceChannelId);
    if (!channel?.members) return;
    const now = new Date();
    for (const member of channel.members.values()) {
      await handleJoin(member, now);
    }
  } catch (err) {
    console.error('[EventTracker] snapshotVoiceChannel error:', err);
  }
}

async function handleJoin(member, timestamp = new Date()) {
  if (!activeRaid) return;

  const discordId = member.id;
  if (activeRaid.members.has(discordId)) return; // already tracking

  const charName   = db.getCharacterByDiscordId(discordId);
  const playerName = charName ?? member.displayName;

  if (!charName) await sendUnlinkedWarning(member);

  activeRaid.members.set(discordId, { name: playerName, firstSeen: timestamp, lastSeen: null });
  db.upsertVoiceAttendance(activeRaid.raidId, playerName, discordId, timestamp, null);
  console.log(`[EventTracker] Join: ${playerName} (raid #${activeRaid.raidId})`);
}

function handleLeave(discordId, timestamp = new Date()) {
  if (!activeRaid) return;
  const memberData = activeRaid.members.get(discordId);
  if (!memberData) return;

  memberData.lastSeen = timestamp;
  db.upsertVoiceAttendance(
    activeRaid.raidId, memberData.name, discordId, memberData.firstSeen, timestamp
  );
  console.log(`[EventTracker] Leave: ${memberData.name} (raid #${activeRaid.raidId})`);
}

async function sendUnlinkedWarning(member) {
  if (!alertChannelId || !_client) return;
  try {
    const channel = await _client.channels.fetch(alertChannelId);
    if (!channel) return;
    await channel.send(
      `⚠️ **Attendance warning:** \`${member.displayName}\` joined the raid voice channel but has no character linked. ` +
      `Use \`/player link\` to associate them. Their attendance is being logged as "${member.displayName}".`
    );
  } catch (err) {
    console.error('[EventTracker] sendUnlinkedWarning error:', err);
  }
}

module.exports = { init, onScheduledEventUpdate, onVoiceStateUpdate };
