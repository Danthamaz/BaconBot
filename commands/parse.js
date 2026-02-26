/**
 * /parse  —  Upload an EQ log file and extract raid data.
 *
 * Input: Discord file attachment (25 MB limit).
 * For large logs, trim to the relevant session first — see /help for instructions.
 */

'use strict';

const { SlashCommandBuilder } = require('discord.js');
const fs    = require('fs');
const path  = require('path');
const os    = require('os');
const https = require('https');
const http  = require('http');

const { parseLog }  = require('../lib/parser');
const { saveRaid, mergeIntoRaid, getRaid } = require('../lib/db');

// ── Helpers ────────────────────────────────────────────────────────────────

/** Stream a Discord CDN URL to a local temp file. */
function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const file   = fs.createWriteStream(destPath);
    const client = url.startsWith('https') ? https : http;
    client.get(url, res => {
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
      file.on('error', reject);
    }).on('error', err => {
      fs.unlink(destPath, () => {});
      reject(err);
    });
  });
}

/**
 * Parse a user-supplied date string into a JS Date.
 * Accepts: "YYYY-MM-DD"  or  "MM/DD/YYYY"
 */
function parseDate(str) {
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);

  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);

  return null;
}

/**
 * Parse a time string "HH:MM" or "HH:MM:SS" and apply it to a Date object (mutates in place).
 */
function applyTime(date, timeStr) {
  const m = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return false;
  date.setHours(+m[1], +m[2], +(m[3] || 0), 0);
  return true;
}

// ── Command definition ─────────────────────────────────────────────────────

module.exports = {
  data: new SlashCommandBuilder()
    .setName('parse')
    .setDescription('Parse an EQ log file and record a raid')
    .addStringOption(o =>
      o.setName('name')
       .setDescription('Raid name, e.g. "VP Thursday 1/23"')
       .setRequired(true))
    .addStringOption(o =>
      o.setName('zone')
       .setDescription('Zone(s) to filter, comma-separated. e.g. "Veeshan\'s Peak" or "Plane of Hate,Plane of Fear"')
       .setRequired(true))
    .addStringOption(o =>
      o.setName('date')
       .setDescription('Raid date — YYYY-MM-DD or MM/DD/YYYY, e.g. "2026-01-23"')
       .setRequired(true))
    .addStringOption(o =>
      o.setName('start_time')
       .setDescription('Raid start (24-hr HH:MM), e.g. "20:54"')
       .setRequired(true))
    .addStringOption(o =>
      o.setName('end_time')
       .setDescription('Raid end (24-hr HH:MM), e.g. "23:30"')
       .setRequired(true))
    .addStringOption(o =>
      o.setName('character')
       .setDescription('Log owner\'s character name, e.g. "Lyri"')
       .setRequired(true))
    .addAttachmentOption(o =>
      o.setName('logfile')
       .setDescription('Attach your EQ log .txt file (25 MB Discord limit — trim large logs first)')
       .setRequired(true))
    .addIntegerOption(o =>
      o.setName('raid_id')
       .setDescription('Merge this log into an existing raid instead of creating a new one')
       .setMinValue(1)),

  // ── Handler ──────────────────────────────────────────────────────────────
  async execute(interaction) {
    if (interaction.deferred || interaction.replied) return;
    await interaction.deferReply();

    try {
      // -- Collect options --
      const raidName     = interaction.options.getString('name');
      const zoneInput    = interaction.options.getString('zone');
      const dateStr      = interaction.options.getString('date');
      const startStr     = interaction.options.getString('start_time');
      const endStr       = interaction.options.getString('end_time');
      const characterName = interaction.options.getString('character');
      const attachment   = interaction.options.getAttachment('logfile');

      // -- Parse dates --
      const startDate = parseDate(dateStr);
      const endDate   = parseDate(dateStr);
      if (!startDate || !endDate) {
        return interaction.editReply(
          '❌ Invalid date format. Use `YYYY-MM-DD` (e.g. `2026-01-23`) or `MM/DD/YYYY`.'
        );
      }
      if (!applyTime(startDate, startStr)) {
        return interaction.editReply('❌ Invalid start time. Use 24-hr format `HH:MM`, e.g. `20:54`.');
      }
      if (!applyTime(endDate, endStr)) {
        return interaction.editReply('❌ Invalid end time. Use 24-hr format `HH:MM`, e.g. `23:30`.');
      }
      // Handle raids that cross midnight
      if (endDate <= startDate) {
        endDate.setDate(endDate.getDate() + 1);
      }

      // -- Parse zones list --
      const zones = zoneInput.split(',').map(z => z.trim()).filter(Boolean);

      // -- Download attachment to temp file --
      const tempFile = path.join(os.tmpdir(), `eq_log_${Date.now()}.txt`);
      await interaction.editReply('⬇️ Downloading log file from Discord...');
      await downloadFile(attachment.url, tempFile);
      const filePath = tempFile;

      // -- Status update --
      await interaction.editReply(
        `⚙️ Parsing log...\n` +
        `📋 **${raidName}** | 🗺️ ${zones.join(', ')}\n` +
        `⏰ ${startDate.toLocaleString()} → ${endDate.toLocaleString()}`
      );

      // -- Run the parser --
      let lastProgressUpdate = Date.now();
      const result = await parseLog({
        filePath,
        startTime:     startDate,
        endTime:       endDate,
        zones,
        characterName,
        onProgress: (lines) => {
          // Rate-limit Discord edits to once per 3 seconds
          const now = Date.now();
          if (now - lastProgressUpdate > 3000) {
            lastProgressUpdate = now;
            interaction.editReply(
              `⚙️ Parsing log... (${(lines / 1000).toFixed(0)}k lines scanned)`
            ).catch(() => {});
          }
        },
      });

      // -- Clean up temp file --
      if (tempFile) fs.unlink(tempFile, () => {});

      // -- Nothing found? --
      if (result.attendance.length === 0 && result.loot.length === 0) {
        return interaction.editReply(
          `⚠️ **No data found** in that time range / zone.\n` +
          `Scanned **${result.lineCount.toLocaleString()}** lines.\n\n` +
          `Double-check:\n` +
          `• Date and time window match when you were in-game\n` +
          `• Zone name is a partial match (e.g. \`veeshan\` matches "Veeshan's Peak")\n` +
          `• The log file covers that date`
        );
      }

      // -- Save or merge --
      const existingRaidId = interaction.options.getInteger('raid_id');

      if (existingRaidId) {
        const existingRaid = getRaid(existingRaidId);
        if (!existingRaid) {
          return interaction.editReply(`❌ No raid found with ID \`${existingRaidId}\`.`);
        }

        const { newLoot } = mergeIntoRaid(existingRaidId, {
          attendance: result.attendance,
          loot:       result.loot,
        });

        await interaction.editReply(
          `✅ **Merged into Raid #${existingRaidId}!**\n` +
          `\n` +
          `📋 **${existingRaid.name}**\n` +
          `\n` +
          `👥 **${result.attendance.length}** players seen in this log\n` +
          `💎 **${newLoot}** new loot events added (${result.loot.length - newLoot} duplicates skipped)\n` +
          `🔍 Scanned ${result.lineCount.toLocaleString()} log lines\n` +
          `\n` +
          `Use \`/attendance raid:${existingRaidId}\` or \`/loot raid:${existingRaidId}\` to view all merged data.`
        );
      } else {
        const raidId = saveRaid({
          name:          raidName,
          zone:          zones.join(', '),
          startTime:     startDate,
          endTime:       endDate,
          characterName,
          submittedBy:   interaction.user.tag,
          attendance:    result.attendance,
          loot:          result.loot,
        });

        await interaction.editReply(
          `✅ **Raid saved!** (ID: \`${raidId}\`)\n` +
          `\n` +
          `📋 **${raidName}**\n` +
          `🗺️ ${zones.join(', ')}\n` +
          `⏰ ${startDate.toLocaleString()} → ${endDate.toLocaleString()}\n` +
          `\n` +
          `👥 **${result.attendance.length}** players in attendance\n` +
          `💎 **${result.loot.length}** loot events captured\n` +
          `🔍 Scanned ${result.lineCount.toLocaleString()} log lines\n` +
          `\n` +
          `Use \`/attendance raid:${raidId}\` or \`/loot raid:${raidId}\` to view details.`
        );
      }
    } catch (err) {
      console.error('[/parse] Error:', err);
      await interaction.editReply(`❌ Parse failed: ${err.message}`);
    }
  },
};
