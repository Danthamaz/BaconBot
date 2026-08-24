'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../lib/db');
const { isOfficer } = require('../lib/permissions');

// ── Duration formatting ──────────────────────────────────────────────────

/** Convert fractional hours to a human-readable string like "2d 18h 3m". */
function formatDuration(hours) {
  const totalMinutes = Math.round(hours * 60);
  const d = Math.floor(totalMinutes / (24 * 60));
  const h = Math.floor((totalMinutes % (24 * 60)) / 60);
  const m = totalMinutes % 60;
  const parts = [];
  if (d > 0) parts.push(`${d}d`);
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  return parts.join(' ') || '0m';
}

// ── Timestamp parsing ──────────────────────────────────────────────────────

/**
 * Parse a time input into a Unix-ms timestamp.
 * Only accepts timezone-safe formats:
 *   "now"                        → current time
 *   "<t:1740700440>"             → Discord timestamp (any style suffix)
 *   "<t:1740700440:F>"           → Discord timestamp with format
 *   "1740700440"                 → Unix seconds (10 digits)
 *   "1740700440000"              → Unix milliseconds (13 digits)
 */
function parseTimestamp(input) {
  const s = input.trim();

  if (s.toLowerCase() === 'now') return Date.now();

  // Relative past: -6h, -2d, -30m, -2d6h30m etc.
  const relMatch = s.match(/^-(.+)$/);
  if (relMatch) {
    const hours = parseLockout(relMatch[1]);
    if (hours != null) return Date.now() - hours * 3600_000;
  }

  // Discord timestamp: <t:1740700440> or <t:1740700440:F> etc.
  const discordMatch = s.match(/^<t:(\d+)(?::[tTdDfFR])?>$/);
  if (discordMatch) {
    return parseInt(discordMatch[1], 10) * 1000;
  }

  // Unix timestamp (all digits, 10-13 chars)
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }

  return null;
}

// ── Lockout duration parsing ───────────────────────────────────────────────

/**
 * Parse a lockout duration string into fractional hours.
 * Supported formats:
 *   "6"                → 6 hours
 *   "6h"               → 6 hours
 *   "2d 18h 3m"        → 66.05 hours
 *   "2d18h3m"          → 66.05 hours
 *   "2 Days, 18 Hours, 3 Minutes, and 20 Seconds"  → EQ paste
 */
function parseLockout(input) {
  const s = input.trim();

  // Plain number (e.g. "6", "3.5")
  if (/^\d+(\.\d+)?$/.test(s)) {
    return parseFloat(s);
  }

  let totalHours = 0;
  let matched = false;

  // Match components: number followed by a unit word/letter
  const pattern = /(\d+(?:\.\d+)?)\s*(?:,?\s*(?:and\s+)?)(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)(?![a-z])/gi;
  let match;
  while ((match = pattern.exec(s)) !== null) {
    matched = true;
    const val = parseFloat(match[1]);
    const unit = match[2].toLowerCase();
    if (unit.startsWith('d'))      totalHours += val * 24;
    else if (unit.startsWith('h')) totalHours += val;
    else if (unit.startsWith('m') && !unit.startsWith('mo')) totalHours += val / 60;
    else if (unit.startsWith('s')) totalHours += val / 3600;
  }

  if (matched && totalHours > 0) {
    return Math.round(totalHours * 1000) / 1000; // avoid floating-point noise
  }

  return null;
}

// ── Status embed helpers ────────────────────────────────────────────────────

/**
 * Render a grouped section into one or more embed fields, splitting at line
 * boundaries so no field value exceeds Discord's 1024-char limit.
 * Continuation fields are named "<name> (cont.)".
 */
function buildStatusFields(name, groups) {
  const lines = [];
  const expansions = Object.keys(groups);
  const multiExpansion = expansions.length > 1 || (expansions.length === 1 && expansions[0] !== 'Other');
  for (const exp of expansions) {
    if (multiExpansion) lines.push(`__${exp}__`);
    lines.push(...groups[exp]);
  }

  const MAX_FIELD_LENGTH = 1024;
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length > MAX_FIELD_LENGTH && current) {
      chunks.push(current);
      current = line;
    } else {
      current = candidate;
    }
  }
  if (current) chunks.push(current);

  return chunks.map((value, i) => ({
    name: i === 0 ? name : `${name} (cont.)`,
    value,
  }));
}

/** Build the full TOD status embed (non-PvP only unless pvpMode=true). */
async function buildFullStatusEmbed(guild, pvpMode = false) {
  const allMobs = db.getTodStatus(pvpMode);
  if (allMobs.length === 0) return null;

  const scheduledEvents = await guild.scheduledEvents.fetch().catch(() => new Map());
  const upcomingEvents = [...scheduledEvents.values()].filter(e => e.status === 1);

  const now = Date.now();
  const unavailable = {};
  const available = {};

  for (const m of allMobs) {
    const exp = m.expansion || 'Other';
    const lockoutMs = m.lockout_hours * 3600_000;
    const respawnAt = m.last_killed_at ? m.last_killed_at + lockoutMs : null;
    const isLocked = respawnAt && respawnAt > now;

    const mobLower = m.name.toLowerCase();
    const event = upcomingEvents
      .filter(e => e.name.toLowerCase().includes(mobLower)
        || (e.description && e.description.toLowerCase().includes(mobLower)))
      .sort((a, b) => a.scheduledStartTimestamp - b.scheduledStartTimestamp)[0];

    const cutoff = event ? event.scheduledStartTimestamp - lockoutMs : null;
    const isReserved = cutoff && cutoff <= now;

    if (isLocked) {
      const respawnUnix = Math.floor(respawnAt / 1000);
      (unavailable[exp] ??= []).push(`**${m.name}** — respawns <t:${respawnUnix}:R> (<t:${respawnUnix}:f>)`);
    } else if (isReserved) {
      const eventUnix = Math.floor(event.scheduledStartTimestamp / 1000);
      (unavailable[exp] ??= []).push(`**${m.name}** — reserved for event <t:${eventUnix}:R> (<t:${eventUnix}:f>)`);
    } else if (event) {
      const cutoffUnix = Math.floor(cutoff / 1000);
      (available[exp] ??= []).push(`**${m.name}** — available until <t:${cutoffUnix}:R> (📅 <t:${cutoffUnix}:f>)`);
    } else if (m.last_killed_at) {
      const respawnUnix = Math.floor(respawnAt / 1000);
      (available[exp] ??= []).push(`**${m.name}** — up since <t:${respawnUnix}:R>`);
    } else {
      (available[exp] ??= []).push(`**${m.name}** — no kills recorded`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle(pvpMode ? 'PvP Target Status 🎯' : 'TOD Status')
    .setColor(pvpMode ? 0xE67E22 : 0x3498DB)
    .setTimestamp();

  if (Object.keys(unavailable).length > 0) {
    embed.addFields(...buildStatusFields('🔴 Unavailable', unavailable));
  }
  if (Object.keys(available).length > 0) {
    embed.addFields(...buildStatusFields('🟢 Available', available));
  }

  return embed;
}

// ── Slash command definition ───────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('tod')
  .setDescription('Track Time of Death for raid mobs')
  .addSubcommand(sub =>
    sub.setName('record')
      .setDescription('Record a mob kill')
      .addStringOption(o => o.setName('mob').setDescription('Mob name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('time').setDescription('Kill time: now or Discord timestamp <t:...>').setRequired(true))
      .addStringOption(o => o.setName('lockout').setDescription('Lockout duration, e.g. 6h, 2d18h3m, or paste from EQ'))
      .addBooleanOption(o => o.setName('pvp').setDescription('Mark as PvP target (officer-only visibility)'))
  )
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Show mob lockout status')
      .addStringOption(o => o.setName('mob').setDescription('Filter to a specific mob').setAutocomplete(true))
      .addBooleanOption(o => o.setName('pvp').setDescription('Show PvP targets (officers only, ephemeral)'))
  )
  .addSubcommand(sub =>
    sub.setName('history')
      .setDescription('Show kill history for a mob')
      .addStringOption(o => o.setName('mob').setDescription('Mob name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('limit').setDescription('Number of entries (1-25)').setMinValue(1).setMaxValue(25))
  )
  .addSubcommand(sub =>
    sub.setName('undo')
      .setDescription('Remove the most recent kill entry')
      .addStringOption(o => o.setName('mob').setDescription('Mob name').setRequired(true).setAutocomplete(true))
  )
  .addSubcommand(sub =>
    sub.setName('mob-add')
      .setDescription('Add a mob to the TOD registry')
      .addStringOption(o => o.setName('name').setDescription('Mob name').setRequired(true))
      .addStringOption(o => o.setName('lockout').setDescription('Lockout duration, e.g. 6h, 2d18h3m, or paste from EQ').setRequired(true))
      .addBooleanOption(o => o.setName('pvp').setDescription('Mark as PvP target (officer-only visibility)'))
      .addStringOption(o => o.setName('expansion').setDescription('EQ expansion').addChoices(
        { name: 'Classic', value: 'Classic' },
        { name: 'Kunark', value: 'Kunark' },
        { name: 'Velious', value: 'Velious' },
        { name: 'Luclin', value: 'Luclin' },
        { name: 'PoP', value: 'PoP' },
      ))
  )
  .addSubcommand(sub =>
    sub.setName('mob-edit')
      .setDescription('Edit a mob\'s lockout or expansion')
      .addStringOption(o => o.setName('name').setDescription('Mob name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('lockout').setDescription('Lockout duration, e.g. 6h, 2d18h3m, or paste from EQ'))
      .addStringOption(o => o.setName('expansion').setDescription('EQ expansion').addChoices(
        { name: 'Classic', value: 'Classic' },
        { name: 'Kunark', value: 'Kunark' },
        { name: 'Velious', value: 'Velious' },
        { name: 'Luclin', value: 'Luclin' },
        { name: 'PoP', value: 'PoP' },
      ))
  )
  .addSubcommand(sub =>
    sub.setName('mob-remove')
      .setDescription('Remove a mob and all its kill history')
      .addStringOption(o => o.setName('name').setDescription('Mob name').setRequired(true).setAutocomplete(true))
  );

// ── Autocomplete ───────────────────────────────────────────────────────────

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused();
  const mobs = db.searchTodMobs(focused);
  await interaction.respond(
    mobs.map(m => ({ name: m.name, value: m.name }))
  );
}

// ── Execute ────────────────────────────────────────────────────────────────

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'record':  return handleRecord(interaction);
    case 'status':  return handleStatus(interaction);
    case 'history': return handleHistory(interaction);
    case 'undo':    return handleUndo(interaction);
    case 'mob-add': return handleMobAdd(interaction);
    case 'mob-edit': return handleMobEdit(interaction);
    case 'mob-remove': return handleMobRemove(interaction);
    default: return interaction.reply({ content: '❌ Unknown subcommand.', ephemeral: true });
  }
}

// ── Subcommand handlers ────────────────────────────────────────────────────

async function handleRecord(interaction) {
  const mobName = interaction.options.getString('mob');
  const timeStr = interaction.options.getString('time');
  const lockoutStr = interaction.options.getString('lockout');
  const pvpFlag = interaction.options.getBoolean('pvp') ?? false;

  const killedAt = parseTimestamp(timeStr);
  if (!killedAt) {
    return interaction.reply({ content: '❌ Could not parse time. Use `now` or a Discord timestamp like `<t:1740700440:F>`.', flags: 64 });
  }

  const lockoutHours = lockoutStr ? parseLockout(lockoutStr) : null;
  if (lockoutStr && lockoutHours == null) {
    return interaction.reply({ content: '❌ Could not parse lockout. Use: `6h`, `2d 18h 3m`, or paste the EQ lockout message.', flags: 64 });
  }

  let mob = db.getTodMob(mobName);

  if (!mob && lockoutHours == null) {
    return interaction.reply({
      content: `❌ **${mobName}** is not in the registry. Re-run with the \`lockout\` option to auto-create it:\n\`/tod record mob:${mobName} time:${timeStr} lockout:6h\``,
      flags: 64,
    });
  }

  if (!mob) {
    db.addTodMob(mobName, lockoutHours, interaction.user.id, pvpFlag, null);
    mob = db.getTodMob(mobName);
  }

  // PvP mob interactions require officer role and respond ephemerally
  const isPvp = !!mob.pvp;
  if (isPvp && !isOfficer(interaction.member)) {
    return interaction.reply({ content: '❌ Only officers can record PvP targets.', flags: 64 });
  }

  // Block if mob is currently in lockout (prevent duplicate kills)
  const latestKill = db.getLatestTodKill(mob.id);
  if (latestKill) {
    const existingRespawn = latestKill.killed_at + mob.lockout_hours * 3600_000;
    if (existingRespawn > Date.now()) {
      const respawnUnix = Math.floor(existingRespawn / 1000);
      return interaction.reply({
        content: `❌ **${mob.name}** is already on lockout — respawns <t:${respawnUnix}:R> (<t:${respawnUnix}:f>). Use \`/tod undo\` first if this needs to be corrected.`,
        flags: 64,
      });
    }
  }

  db.recordTodKill(mob.id, killedAt, interaction.user.id);

  const respawnAt = killedAt + mob.lockout_hours * 3600_000;
  const killUnix = Math.floor(killedAt / 1000);
  const respawnUnix = Math.floor(respawnAt / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`TOD Recorded: ${mob.name}${isPvp ? ' 🎯' : ''}`)
    .setColor(isPvp ? 0xE67E22 : 0x00AE86)
    .addFields(
      { name: 'Killed', value: `<t:${killUnix}:f> (<t:${killUnix}:R>)`, inline: true },
      { name: 'Respawn', value: `<t:${respawnUnix}:f> (<t:${respawnUnix}:R>)`, inline: true },
      { name: 'Lockout', value: formatDuration(mob.lockout_hours), inline: true },
    );

  await interaction.reply({ embeds: [embed], ...(isPvp && { flags: 64 }) });

  // Post public status update to channel
  if (!isPvp) {
    const statusEmbed = await buildFullStatusEmbed(interaction.guild);
    if (statusEmbed) {
      interaction.channel.send({ embeds: [statusEmbed] }).catch(() => {});
    }
  }
}

async function handleStatus(interaction) {
  const mobFilter = interaction.options.getString('mob');
  const pvpMode = interaction.options.getBoolean('pvp') ?? false;

  if (pvpMode && !isOfficer(interaction.member)) {
    return interaction.reply({ content: '❌ Only officers can view PvP targets.', flags: 64 });
  }

  if (mobFilter) {
    const mob = db.getTodMob(mobFilter);
    if (!mob) return interaction.reply({ content: `❌ Mob **${mobFilter}** not found.`, flags: 64 });

    // Block non-officers from viewing PvP mobs directly
    const isPvp = !!mob.pvp;
    if (isPvp && !isOfficer(interaction.member)) {
      return interaction.reply({ content: `❌ Mob **${mobFilter}** not found.`, flags: 64 });
    }

    const kill = db.getLatestTodKill(mob.id);
    const now = Date.now();
    const respawnAt = kill ? kill.killed_at + mob.lockout_hours * 3600_000 : null;
    const isLocked = respawnAt && respawnAt > now;

    // Check for a scheduled event matching this mob
    const scheduledEvents = await interaction.guild.scheduledEvents.fetch().catch(() => new Map());
    const mobLower = mob.name.toLowerCase();
    const event = [...scheduledEvents.values()]
      .filter(e => e.status === 1)
      .find(e => e.name.toLowerCase().includes(mobLower)
        || (e.description && e.description.toLowerCase().includes(mobLower)));

    const color = isLocked ? 0xE74C3C : event ? 0xF39C12 : 0x2ECC71;
    const embed = new EmbedBuilder()
      .setTitle(`TOD Status: ${mob.name}${isPvp ? ' 🎯' : ''}`)
      .setColor(color);

    if (kill) {
      const killUnix = Math.floor(kill.killed_at / 1000);
      const respawnUnix = Math.floor(respawnAt / 1000);
      embed.addFields(
        { name: 'Last Kill', value: `<t:${killUnix}:f> (<t:${killUnix}:R>)`, inline: true },
        { name: isLocked ? 'Respawn' : 'Respawned', value: `<t:${respawnUnix}:f> (<t:${respawnUnix}:R>)`, inline: true },
        { name: 'Lockout', value: formatDuration(mob.lockout_hours), inline: true },
      );
    } else {
      embed.setDescription('No kills recorded — mob is available.');
    }
    if (event) {
      const eventUnix = Math.floor(event.scheduledStartTimestamp / 1000);
      embed.addFields({ name: '📅 Scheduled Event', value: `**${event.name}** — <t:${eventUnix}:f> (<t:${eventUnix}:R>)` });
    }
    return interaction.reply({ embeds: [embed], ...(isPvp && { flags: 64 }) });
  }

  // Full status view
  const embed = await buildFullStatusEmbed(interaction.guild, pvpMode);
  if (!embed) {
    const msg = pvpMode
      ? 'No PvP targets in the registry. Use `/tod mob-add` with `pvp: True` to add one.'
      : 'No mobs in the TOD registry. Use `/tod mob-add` to add one.';
    return interaction.reply({ content: msg, flags: 64 });
  }

  return interaction.reply({ embeds: [embed], ...(pvpMode && { flags: 64 }) });
}

async function handleHistory(interaction) {
  const mobName = interaction.options.getString('mob');
  const limit = interaction.options.getInteger('limit') ?? 10;

  const mob = db.getTodMob(mobName);
  if (!mob) return interaction.reply({ content: `❌ Mob **${mobName}** not found.`, flags: 64 });

  const isPvp = !!mob.pvp;
  if (isPvp && !isOfficer(interaction.member)) {
    return interaction.reply({ content: `❌ Mob **${mobName}** not found.`, flags: 64 });
  }

  const kills = db.getTodKillHistory(mob.id, limit);
  if (kills.length === 0) {
    return interaction.reply({ content: `No kill history for **${mob.name}**.`, flags: 64 });
  }

  const lines = kills.map((k, i) => {
    const unix = Math.floor(k.killed_at / 1000);
    const by = k.recorded_by ? ` (by <@${k.recorded_by}>)` : '';
    return `${i + 1}. <t:${unix}:f> (<t:${unix}:R>)${by}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`Kill History: ${mob.name}${isPvp ? ' 🎯' : ''}`)
    .setDescription(lines.join('\n'))
    .setColor(0x9B59B6)
    .setFooter({ text: `Lockout: ${formatDuration(mob.lockout_hours)}` });

  return interaction.reply({ embeds: [embed], ...(isPvp && { flags: 64 }) });
}

async function handleUndo(interaction) {
  const mobName = interaction.options.getString('mob');
  const mob = db.getTodMob(mobName);
  if (!mob) return interaction.reply({ content: `❌ Mob **${mobName}** not found.`, flags: 64 });

  const isPvp = !!mob.pvp;
  if (isPvp && !isOfficer(interaction.member)) {
    return interaction.reply({ content: `❌ Mob **${mobName}** not found.`, flags: 64 });
  }

  const removed = db.undoLastTodKill(mob.id);
  if (!removed) {
    return interaction.reply({ content: `No kill entries to undo for **${mob.name}**.`, flags: 64 });
  }

  const unix = Math.floor(removed.killed_at / 1000);
  await interaction.reply({ content: `✅ Removed kill entry for **${mob.name}** from <t:${unix}:f>.`, ...(isPvp && { flags: 64 }) });

  // Post public status update to channel
  if (!isPvp) {
    const statusEmbed = await buildFullStatusEmbed(interaction.guild);
    if (statusEmbed) {
      interaction.channel.send({ embeds: [statusEmbed] }).catch(() => {});
    }
  }
}

async function handleMobAdd(interaction) {
  const name = interaction.options.getString('name');
  const lockoutStr = interaction.options.getString('lockout');
  const pvpFlag = interaction.options.getBoolean('pvp') ?? false;
  const expansion = interaction.options.getString('expansion') ?? null;

  // Acknowledge immediately — copy-paste can delay client→gateway delivery
  // past Discord's 3-second interaction deadline
  await interaction.deferReply({ ...(pvpFlag && { flags: 64 }) });

  const lockout = parseLockout(lockoutStr);

  if (lockout == null) {
    return interaction.editReply({ content: '❌ Could not parse lockout. Use: `6h`, `2d 18h 3m`, or paste the EQ lockout message.' });
  }

  if (pvpFlag && !isOfficer(interaction.member)) {
    return interaction.editReply({ content: '❌ Only officers can add PvP targets.' });
  }

  const existing = db.getTodMob(name);
  if (existing) {
    return interaction.editReply({ content: `❌ **${existing.name}** already exists (lockout: ${formatDuration(existing.lockout_hours)}). Use \`/tod mob-edit\` to change it.` });
  }

  db.addTodMob(name, lockout, interaction.user.id, pvpFlag, expansion);
  const label = pvpFlag ? `✅ Added PvP target **${name}**` : `✅ Added **${name}**`;
  const expLabel = expansion ? ` [${expansion}]` : '';
  return interaction.editReply({ content: `${label}${expLabel} with a **${formatDuration(lockout)}** lockout.` });
}

async function handleMobEdit(interaction) {
  const name = interaction.options.getString('name');
  const lockoutStr = interaction.options.getString('lockout');
  const expansion = interaction.options.getString('expansion');

  const lockout = lockoutStr ? parseLockout(lockoutStr) : undefined;
  if (lockoutStr && lockout == null) {
    return interaction.reply({ content: '❌ Could not parse lockout. Use: `6h`, `2d 18h 3m`, or paste the EQ lockout message.', flags: 64 });
  }

  if (lockout === undefined && expansion === undefined) {
    return interaction.reply({ content: '❌ Provide at least one of `lockout` or `expansion` to update.', flags: 64 });
  }

  const mob = db.getTodMob(name);
  if (!mob) return interaction.reply({ content: `❌ Mob **${name}** not found.`, flags: 64 });

  const isPvp = !!mob.pvp;
  if (isPvp && !isOfficer(interaction.member)) {
    return interaction.reply({ content: `❌ Mob **${name}** not found.`, flags: 64 });
  }

  const updates = {};
  if (lockout !== undefined) updates.lockoutHours = lockout;
  if (expansion !== undefined) updates.expansion = expansion;
  db.updateTodMob(mob.name, updates);

  const parts = [];
  if (lockout !== undefined) parts.push(`lockout: ${formatDuration(mob.lockout_hours)} → **${formatDuration(lockout)}**`);
  if (expansion !== undefined) parts.push(`expansion: ${mob.expansion || 'none'} → **${expansion || 'none'}**`);
  return interaction.reply({ content: `✅ Updated **${mob.name}** ${parts.join(', ')}.`, ...(isPvp && { flags: 64 }) });
}

async function handleMobRemove(interaction) {
  const name = interaction.options.getString('name');

  const mob = db.getTodMob(name);
  if (!mob) return interaction.reply({ content: `❌ Mob **${name}** not found.`, flags: 64 });

  const isPvp = !!mob.pvp;
  if (isPvp && !isOfficer(interaction.member)) {
    return interaction.reply({ content: `❌ Mob **${name}** not found.`, flags: 64 });
  }

  db.removeTodMob(mob.name);
  return interaction.reply({ content: `✅ Removed **${mob.name}** and all its kill history.`, ...(isPvp && { flags: 64 }) });
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  data,
  execute,
  autocomplete,
  buildStatusFields, // exported for testing
  extraChannels: [process.env.TOD_CHANNEL_ID].filter(Boolean),
};
