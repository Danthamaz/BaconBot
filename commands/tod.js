'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../lib/db');

// ── Timestamp parsing ──────────────────────────────────────────────────────

/**
 * Parse a human-friendly time string into a Unix-ms timestamp.
 * Supported formats:
 *   "now"
 *   "14:34"          → today at that 24h time
 *   "2:34pm"         → today at that 12h time
 *   "2/27 14:34"     → this year, month/day at time
 *   "2026-02-27 14:34" → full date + time
 *   numeric string   → treated as unix seconds
 */
function parseTimestamp(input) {
  const s = input.trim().toLowerCase();

  if (s === 'now') return Date.now();

  // Unix timestamp (all digits, 10+ chars)
  if (/^\d{10,13}$/.test(s)) {
    const n = Number(s);
    return n > 1e12 ? n : n * 1000;
  }

  // 12-hour time: "2:34pm", "11:00am"
  const match12 = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)$/);
  if (match12) {
    let h = parseInt(match12[1], 10);
    const m = parseInt(match12[2], 10);
    if (match12[3] === 'pm' && h !== 12) h += 12;
    if (match12[3] === 'am' && h === 12) h = 0;
    const d = new Date();
    d.setHours(h, m, 0, 0);
    return d.getTime();
  }

  // 24-hour time only: "14:34"
  const match24 = s.match(/^(\d{1,2}):(\d{2})$/);
  if (match24) {
    const d = new Date();
    d.setHours(parseInt(match24[1], 10), parseInt(match24[2], 10), 0, 0);
    return d.getTime();
  }

  // M/D HH:MM  → current year
  const matchMD = s.match(/^(\d{1,2})\/(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (matchMD) {
    const d = new Date();
    d.setMonth(parseInt(matchMD[1], 10) - 1, parseInt(matchMD[2], 10));
    d.setHours(parseInt(matchMD[3], 10), parseInt(matchMD[4], 10), 0, 0);
    return d.getTime();
  }

  // YYYY-MM-DD HH:MM
  const matchFull = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})\s+(\d{1,2}):(\d{2})$/);
  if (matchFull) {
    const d = new Date(
      parseInt(matchFull[1], 10),
      parseInt(matchFull[2], 10) - 1,
      parseInt(matchFull[3], 10),
      parseInt(matchFull[4], 10),
      parseInt(matchFull[5], 10),
      0, 0
    );
    return d.getTime();
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
      .addStringOption(o => o.setName('time').setDescription('Kill time: now, 14:34, 2:34pm, 2/27 14:34').setRequired(true))
      .addNumberOption(o => o.setName('lockout').setDescription('Lockout hours (creates mob if unknown)'))
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
      .addNumberOption(o => o.setName('lockout').setDescription('Lockout duration in hours').setRequired(true))
  )
  .addSubcommand(sub =>
    sub.setName('mob-edit')
      .setDescription('Change a mob\'s lockout duration')
      .addStringOption(o => o.setName('name').setDescription('Mob name').setRequired(true).setAutocomplete(true))
      .addNumberOption(o => o.setName('lockout').setDescription('New lockout duration in hours').setRequired(true))
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
  const lockout = interaction.options.getNumber('lockout');

  const killedAt = parseTimestamp(timeStr);
  if (!killedAt) {
    return interaction.reply({ content: '❌ Could not parse time. Use: `now`, `14:34`, `2:34pm`, `2/27 14:34`, or `2026-02-27 14:34`.', flags: 64 });
  }

  let mob = db.getTodMob(mobName);

  if (!mob && lockout == null) {
    return interaction.reply({
      content: `❌ **${mobName}** is not in the registry. Re-run with the \`lockout\` option to auto-create it:\n\`/tod record mob:${mobName} time:${timeStr} lockout:<hours>\``,
      flags: 64,
    });
  }

  if (!mob) {
    db.addTodMob(mobName, lockout, interaction.user.id);
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
      { name: 'Lockout', value: `${mob.lockout_hours}h`, inline: true },
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
        { name: 'Lockout', value: `${mob.lockout_hours}h`, inline: true },
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
    .setFooter({ text: `Lockout: ${mob.lockout_hours}h` });

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
  const lockout = interaction.options.getNumber('lockout');

  const existing = db.getTodMob(name);
  if (existing) {
    return interaction.reply({ content: `❌ **${existing.name}** already exists (lockout: ${existing.lockout_hours}h). Use \`/tod mob-edit\` to change it.`, flags: 64 });
  }

  db.addTodMob(name, lockout, interaction.user.id);
  return interaction.reply({ content: `✅ Added **${name}** with a ${lockout}h lockout.` });
}

async function handleMobEdit(interaction) {
  const name = interaction.options.getString('name');
  const lockout = interaction.options.getNumber('lockout');

  const mob = db.getTodMob(name);
  if (!mob) return interaction.reply({ content: `❌ Mob **${name}** not found.`, flags: 64 });

  db.updateTodMob(mob.name, lockout);
  return interaction.reply({ content: `✅ Updated **${mob.name}** lockout: ${mob.lockout_hours}h → ${lockout}h.` });
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
  extraChannels: ['1464353128022278154'],
};
