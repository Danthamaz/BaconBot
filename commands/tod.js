'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../lib/db');

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
  const pattern = /(\d+(?:\.\d+)?)\s*(?:,?\s*(?:and\s+)?)(days?|d|hours?|hrs?|h|minutes?|mins?|m|seconds?|secs?|s)\b/gi;
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
  )
  .addSubcommand(sub =>
    sub.setName('status')
      .setDescription('Show mob lockout status')
      .addStringOption(o => o.setName('mob').setDescription('Filter to a specific mob').setAutocomplete(true))
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
  )
  .addSubcommand(sub =>
    sub.setName('mob-edit')
      .setDescription('Change a mob\'s lockout duration')
      .addStringOption(o => o.setName('name').setDescription('Mob name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('lockout').setDescription('Lockout duration, e.g. 6h, 2d18h3m, or paste from EQ').setRequired(true))
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
  }
}

// ── Subcommand handlers ────────────────────────────────────────────────────

async function handleRecord(interaction) {
  const mobName = interaction.options.getString('mob');
  const timeStr = interaction.options.getString('time');
  const lockoutStr = interaction.options.getString('lockout');

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
    db.addTodMob(mobName, lockoutHours, interaction.user.id);
    mob = db.getTodMob(mobName);
  }

  db.recordTodKill(mob.id, killedAt, interaction.user.id);

  const respawnAt = killedAt + mob.lockout_hours * 3600_000;
  const killUnix = Math.floor(killedAt / 1000);
  const respawnUnix = Math.floor(respawnAt / 1000);

  const embed = new EmbedBuilder()
    .setTitle(`TOD Recorded: ${mob.name}`)
    .setColor(0x00AE86)
    .addFields(
      { name: 'Killed', value: `<t:${killUnix}:f> (<t:${killUnix}:R>)`, inline: true },
      { name: 'Respawn', value: `<t:${respawnUnix}:f> (<t:${respawnUnix}:R>)`, inline: true },
      { name: 'Lockout', value: formatDuration(mob.lockout_hours), inline: true },
    );

  return interaction.reply({ embeds: [embed] });
}

async function handleStatus(interaction) {
  const mobFilter = interaction.options.getString('mob');

  if (mobFilter) {
    const mob = db.getTodMob(mobFilter);
    if (!mob) return interaction.reply({ content: `❌ Mob **${mobFilter}** not found.`, flags: 64 });
    const kill = db.getLatestTodKill(mob.id);
    const now = Date.now();
    const respawnAt = kill ? kill.killed_at + mob.lockout_hours * 3600_000 : null;
    const isLocked = respawnAt && respawnAt > now;

    const embed = new EmbedBuilder()
      .setTitle(`TOD Status: ${mob.name}`)
      .setColor(isLocked ? 0xE74C3C : 0x2ECC71);

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
    return interaction.reply({ embeds: [embed] });
  }

  // Full status view
  const allMobs = db.getTodStatus();
  if (allMobs.length === 0) {
    return interaction.reply({ content: 'No mobs in the TOD registry. Use `/tod mob-add` to add one.', flags: 64 });
  }

  const now = Date.now();
  const locked = [];
  const available = [];

  for (const m of allMobs) {
    const respawnAt = m.last_killed_at ? m.last_killed_at + m.lockout_hours * 3600_000 : null;
    if (respawnAt && respawnAt > now) {
      const respawnUnix = Math.floor(respawnAt / 1000);
      locked.push(`**${m.name}** — respawns <t:${respawnUnix}:R> (<t:${respawnUnix}:f>)`);
    } else if (m.last_killed_at) {
      const respawnUnix = Math.floor(respawnAt / 1000);
      available.push(`**${m.name}** — up since <t:${respawnUnix}:R>`);
    } else {
      available.push(`**${m.name}** — no kills recorded`);
    }
  }

  const embed = new EmbedBuilder()
    .setTitle('TOD Status')
    .setColor(0x3498DB)
    .setTimestamp();

  if (locked.length > 0) {
    embed.addFields({ name: '🔴 Locked Out', value: locked.join('\n') });
  }
  if (available.length > 0) {
    embed.addFields({ name: '🟢 Available', value: available.join('\n') });
  }

  return interaction.reply({ embeds: [embed] });
}

async function handleHistory(interaction) {
  const mobName = interaction.options.getString('mob');
  const limit = interaction.options.getInteger('limit') ?? 10;

  const mob = db.getTodMob(mobName);
  if (!mob) return interaction.reply({ content: `❌ Mob **${mobName}** not found.`, flags: 64 });

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
    .setTitle(`Kill History: ${mob.name}`)
    .setDescription(lines.join('\n'))
    .setColor(0x9B59B6)
    .setFooter({ text: `Lockout: ${formatDuration(mob.lockout_hours)}` });

  return interaction.reply({ embeds: [embed] });
}

async function handleUndo(interaction) {
  const mobName = interaction.options.getString('mob');
  const mob = db.getTodMob(mobName);
  if (!mob) return interaction.reply({ content: `❌ Mob **${mobName}** not found.`, flags: 64 });

  const removed = db.undoLastTodKill(mob.id);
  if (!removed) {
    return interaction.reply({ content: `No kill entries to undo for **${mob.name}**.`, flags: 64 });
  }

  const unix = Math.floor(removed.killed_at / 1000);
  return interaction.reply({ content: `✅ Removed kill entry for **${mob.name}** from <t:${unix}:f>.` });
}

async function handleMobAdd(interaction) {
  const name = interaction.options.getString('name');
  const lockoutStr = interaction.options.getString('lockout');
  const lockout = parseLockout(lockoutStr);

  if (lockout == null) {
    return interaction.reply({ content: '❌ Could not parse lockout. Use: `6h`, `2d 18h 3m`, or paste the EQ lockout message.', flags: 64 });
  }

  const existing = db.getTodMob(name);
  if (existing) {
    return interaction.reply({ content: `❌ **${existing.name}** already exists (lockout: ${formatDuration(existing.lockout_hours)}). Use \`/tod mob-edit\` to change it.`, flags: 64 });
  }

  db.addTodMob(name, lockout, interaction.user.id);
  return interaction.reply({ content: `✅ Added **${name}** with a **${formatDuration(lockout)}** lockout.` });
}

async function handleMobEdit(interaction) {
  const name = interaction.options.getString('name');
  const lockoutStr = interaction.options.getString('lockout');
  const lockout = parseLockout(lockoutStr);

  if (lockout == null) {
    return interaction.reply({ content: '❌ Could not parse lockout. Use: `6h`, `2d 18h 3m`, or paste the EQ lockout message.', flags: 64 });
  }

  const mob = db.getTodMob(name);
  if (!mob) return interaction.reply({ content: `❌ Mob **${name}** not found.`, flags: 64 });

  db.updateTodMob(mob.name, lockout);
  return interaction.reply({ content: `✅ Updated **${mob.name}** lockout: ${formatDuration(mob.lockout_hours)} → **${formatDuration(lockout)}**.` });
}

async function handleMobRemove(interaction) {
  const name = interaction.options.getString('name');

  const mob = db.getTodMob(name);
  if (!mob) return interaction.reply({ content: `❌ Mob **${name}** not found.`, flags: 64 });

  db.removeTodMob(mob.name);
  return interaction.reply({ content: `✅ Removed **${mob.name}** and all its kill history.` });
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  data,
  execute,
  autocomplete,
  extraChannels: [process.env.TOD_CHANNEL_ID].filter(Boolean),
};
