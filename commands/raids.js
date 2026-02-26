/**
 * /raids  —  List all recorded raids.
 * /raids delete  —  Remove a raid record.
 */

'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { getRaids, getRaidCount, getRaid, updateRaid, deleteRaid } = require('../lib/db');

function parseDate(str) {
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  return null;
}

function applyTime(date, timeStr) {
  const m = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return false;
  date.setHours(+m[1], +m[2], +(m[3] || 0), 0);
  return true;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('raids')
    .setDescription('List and manage recorded raids')
    .addSubcommand(sub =>
      sub.setName('list')
         .setDescription('List recorded raids')
         .addIntegerOption(o =>
           o.setName('page').setDescription('Page number (default: 1)').setMinValue(1)))
    .addSubcommand(sub =>
      sub.setName('info')
         .setDescription('Show details for a specific raid')
         .addIntegerOption(o =>
           o.setName('id').setDescription('Raid ID').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('edit')
         .setDescription('Edit a raid\'s name, zone, or time window')
         .addIntegerOption(o =>
           o.setName('id').setDescription('Raid ID to edit').setRequired(true))
         .addStringOption(o =>
           o.setName('name').setDescription('New raid name'))
         .addStringOption(o =>
           o.setName('zone').setDescription('New zone (comma-separated)'))
         .addStringOption(o =>
           o.setName('date').setDescription('New date — YYYY-MM-DD or MM/DD/YYYY'))
         .addStringOption(o =>
           o.setName('start_time').setDescription('New start time (24-hr HH:MM)'))
         .addStringOption(o =>
           o.setName('end_time').setDescription('New end time (24-hr HH:MM)')))
    .addSubcommand(sub =>
      sub.setName('delete')
         .setDescription('Delete a raid record (irreversible)')
         .addIntegerOption(o =>
           o.setName('id').setDescription('Raid ID to delete').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── /raids list ─────────────────────────────────────────────────────────
    if (sub === 'list') {
      const page   = (interaction.options.getInteger('page') ?? 1) - 1;
      const limit  = 8;
      const offset = page * limit;
      const raids  = getRaids(limit, offset);
      const total  = getRaidCount();

      if (raids.length === 0) {
        return interaction.reply(
          page === 0
            ? '📭 No raids recorded yet. Use `/parse` to import a log file.'
            : '📭 No more raids on this page.'
        );
      }

      const lines = raids.map(r =>
        `**[${r.id}]** ${r.name}\n` +
        `↳ 🗺️ ${r.zone}  •  📅 ${formatDate(r.start_time)}  ` +
        `${formatTime(r.start_time)}–${formatTime(r.end_time)}\n` +
        `↳ 👥 ${r.attendance_count} players  •  💎 ${r.loot_count} items`
      );

      const totalPages = Math.ceil(total / limit);

      const embed = new EmbedBuilder()
        .setTitle('📋 Recorded Raids')
        .setColor(0x8B0000)
        .setDescription(lines.join('\n\n'))
        .setFooter({ text: `Page ${page + 1} of ${totalPages}  •  ${total} total raids  •  Use /raids list page:${page + 2} for next` });

      return interaction.reply({ embeds: [embed] });
    }

    // ── /raids info ──────────────────────────────────────────────────────────
    if (sub === 'info') {
      const id   = interaction.options.getInteger('id');
      const raid = getRaid(id);
      if (!raid) {
        return interaction.reply(`❌ No raid found with ID \`${id}\`.`);
      }

      const embed = new EmbedBuilder()
        .setTitle(`📋 Raid #${raid.id}: ${raid.name}`)
        .setColor(0x8B0000)
        .addFields(
          { name: 'Zone',        value: raid.zone,                                       inline: true },
          { name: 'Date',        value: formatDate(raid.start_time),                     inline: true },
          { name: 'Time',        value: `${formatTime(raid.start_time)} – ${formatTime(raid.end_time)}`, inline: true },
          { name: 'Log Owner',   value: raid.character_name || 'Unknown',                inline: true },
          { name: 'Submitted By',value: raid.submitted_by  || 'Unknown',                 inline: true },
        )
        .setFooter({ text: `Use /attendance raid:${id} or /loot raid:${id} to dig in` });

      return interaction.reply({ embeds: [embed] });
    }

    // ── /raids edit ──────────────────────────────────────────────────────────
    if (sub === 'edit') {
      const id   = interaction.options.getInteger('id');
      const raid = getRaid(id);
      if (!raid) {
        return interaction.reply(`❌ No raid found with ID \`${id}\`.`);
      }

      const newName      = interaction.options.getString('name');
      const newZoneInput = interaction.options.getString('zone');
      const newDateStr   = interaction.options.getString('date');
      const newStartStr  = interaction.options.getString('start_time');
      const newEndStr    = interaction.options.getString('end_time');

      if (!newName && !newZoneInput && !newDateStr && !newStartStr && !newEndStr) {
        return interaction.reply('❌ Provide at least one field to change (name, zone, date, start_time, or end_time).');
      }

      // Resolve updated times, falling back to existing values
      let startTime = null;
      let endTime   = null;

      if (newDateStr || newStartStr || newEndStr) {
        const baseDate = newDateStr ? parseDate(newDateStr) : new Date(raid.start_time);
        if (newDateStr && !baseDate) {
          return interaction.reply('❌ Invalid date format. Use `YYYY-MM-DD` or `MM/DD/YYYY`.');
        }

        startTime = new Date(newDateStr ? baseDate : raid.start_time);
        endTime   = new Date(newDateStr ? baseDate : raid.end_time);

        if (newStartStr && !applyTime(startTime, newStartStr)) {
          return interaction.reply('❌ Invalid start time. Use 24-hr `HH:MM`.');
        }
        if (newEndStr && !applyTime(endTime, newEndStr)) {
          return interaction.reply('❌ Invalid end time. Use 24-hr `HH:MM`.');
        }
        if (newDateStr && !newStartStr) startTime.setHours(...[new Date(raid.start_time)].map(d => [d.getHours(), d.getMinutes(), d.getSeconds()]).flat());
        if (newDateStr && !newEndStr)   endTime.setHours(...[new Date(raid.end_time)].map(d => [d.getHours(), d.getMinutes(), d.getSeconds()]).flat());
        if (endTime <= startTime) endTime.setDate(endTime.getDate() + 1);
      }

      updateRaid(id, {
        name:      newName      || null,
        zone:      newZoneInput || null,
        startTime: startTime    || null,
        endTime:   endTime      || null,
      });

      const updated = getRaid(id);
      const embed = new EmbedBuilder()
        .setTitle(`✅ Raid #${id} Updated`)
        .setColor(0x8B0000)
        .addFields(
          { name: 'Name',  value: updated.name,                                                          inline: true },
          { name: 'Zone',  value: updated.zone,                                                          inline: true },
          { name: 'Date',  value: formatDate(updated.start_time),                                        inline: true },
          { name: 'Time',  value: `${formatTime(updated.start_time)} – ${formatTime(updated.end_time)}`, inline: true },
        );
      return interaction.reply({ embeds: [embed] });
    }

    // ── /raids delete ────────────────────────────────────────────────────────
    if (sub === 'delete') {
      const id   = interaction.options.getInteger('id');
      const raid = getRaid(id);
      if (!raid) {
        return interaction.reply(`❌ No raid found with ID \`${id}\`.`);
      }

      deleteRaid(id);
      return interaction.reply(
        `🗑️ Raid **#${id} — ${raid.name}** has been deleted, along with all its attendance and loot records.`
      );
    }
  },
};
