/**
 * /attendance  —  View raid attendance, with Discord-aware player lookups.
 *
 * Subcommands:
 *   /attendance raid    id:<raidId>           — who attended a specific raid
 *   /attendance player  user:@Someone         — all raids a Discord user attended
 *   /attendance player  character:Lyri        — same, but by character name
 */

'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getRaid,
  getRaidAttendance,
  getPlayerAttendance,
  enrichWithDiscordInfo,
  resolveCharacterNames,
  getDiscordInfoForChar,
} = require('../lib/db');

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric', year: 'numeric',
  });
}

// EQ class display order
const CLASS_ORDER = [
  'Warrior', 'Paladin', 'Shadow Knight', 'Ranger', 'Monk', 'Bard',
  'Rogue', 'Shaman', 'Beastlord', 'Druid', 'Wizard', 'Magician',
  'Enchanter', 'Necromancer', 'Cleric', 'Unknown',
];

function groupByClass(rows) {
  const map = {};
  for (const p of rows) {
    const cls = p.class || 'Unknown';
    if (!map[cls]) map[cls] = [];
    map[cls].push(p);
  }
  const sorted = {};
  const known = CLASS_ORDER.filter(c => map[c]);
  const rest  = Object.keys(map).filter(c => !CLASS_ORDER.includes(c)).sort();
  for (const c of [...known, ...rest]) {
    sorted[c] = map[c].sort((a, b) => a.player_name.localeCompare(b.player_name));
  }
  return sorted;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('attendance')
    .setDescription('View raid attendance')
    .addSubcommand(sub =>
      sub.setName('raid')
         .setDescription('Show who attended a specific raid')
         .addIntegerOption(o =>
           o.setName('id').setDescription('Raid ID').setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('player')
         .setDescription("Show a player's full attendance history")
         .addUserOption(o =>
           o.setName('user')
            .setDescription('Discord user (preferred)'))
         .addStringOption(o =>
           o.setName('character')
            .setDescription('Or look up by in-game character name'))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── /attendance raid ──────────────────────────────────────────────────────
    if (sub === 'raid') {
      const id   = interaction.options.getInteger('id');
      const raid = getRaid(id);
      if (!raid) return interaction.reply(`❌ No raid found with ID \`${id}\`.`);

      const attendance = getRaidAttendance(id);
      if (attendance.length === 0) {
        return interaction.reply(`No attendance data recorded for raid **${raid.name}** (#${id}).`);
      }

      // Enrich each row with its Discord info so we can show @mentions
      const enriched = enrichWithDiscordInfo(attendance);
      const byClass  = groupByClass(enriched);

      const classLines = Object.entries(byClass).map(([cls, players]) => {
        const names = players.map(p => {
          const lvl   = p.level ? `${p.level}` : '?';
          // If this character is linked to Discord, show a mention after the name
          const badge = p.discord_id ? ` <@${p.discord_id}>` : '';
          return `${p.player_name}${badge} (${lvl})`;
        }).join(', ');
        return `**${cls}** [${players.length}]: ${names}`;
      });

      const fullText    = classLines.join('\n');
      const description = fullText.length > 3800
        ? fullText.slice(0, 3800) + '\n*(list truncated)*'
        : fullText;

      const embed = new EmbedBuilder()
        .setTitle(`👥 ${raid.name} — Attendance`)
        .setColor(0x228B22)
        .setDescription(description)
        .addFields(
          { name: '🗺️ Zone',    value: raid.zone,                   inline: true },
          { name: '📅 Date',    value: formatDate(raid.start_time), inline: true },
          { name: '👤 Players', value: `${attendance.length}`,      inline: true },
        )
        .setFooter({ text: `Raid #${id}  •  Linked chars show Discord mentions  •  /loot raid:${id}` });

      return interaction.reply({ embeds: [embed] });
    }

    // ── /attendance player ────────────────────────────────────────────────────
    if (sub === 'player') {
      const discordUser = interaction.options.getUser('user');
      const charName    = interaction.options.getString('character');

      if (!discordUser && !charName) {
        return interaction.reply({
          content: '❌ Please provide either a Discord **user** mention or a **character** name.',
          ephemeral: true,
        });
      }

      // Determine the lookup term and a human-friendly label
      let lookupTerm, displayLabel, allChars;

      if (discordUser) {
        lookupTerm   = discordUser.id;
        allChars     = resolveCharacterNames(discordUser.id);
        displayLabel = discordUser.username +
          (allChars.length > 0 ? ` (${allChars.join(', ')})` : '');
      } else {
        // Resolve character name → discord user if linked
        const info = getDiscordInfoForChar(charName);
        lookupTerm   = info ? info.discord_id : charName;
        allChars     = resolveCharacterNames(lookupTerm);
        displayLabel = info
          ? `${info.discord_tag} (${allChars.join(', ')})`
          : charName;
      }

      const records = getPlayerAttendance(lookupTerm);

      if (records.length === 0) {
        const searched = allChars.length > 1
          ? `Searched across: ${allChars.map(c => `\`${c}\``).join(', ')}`
          : 'No records found. Double-check the spelling or link the character first.';
        return interaction.reply(`No attendance records found for **${displayLabel}**.\n${searched}`);
      }

      const lines = records.map(r => {
        const classInfo = r.class ? ` — ${r.level} ${r.class}` : '';
        const charNote  = allChars.length > 1 && r.character_name
          ? ` *(as \`${r.character_name}\`)*`
          : '';
        return `• **[${r.id}]** ${r.name}${classInfo}${charNote}\n  📅 ${formatDate(r.start_time)}  🗺️ ${r.zone}`;
      });

      // Build the title with a Discord mention if we have a user ID
      const titleMention = discordUser
        ? `<@${discordUser.id}>`
        : (getDiscordInfoForChar(charName)?.discord_id
            ? `<@${getDiscordInfoForChar(charName).discord_id}>`
            : charName);

      const embed = new EmbedBuilder()
        .setTitle(`👤 Attendance History`)
        .setDescription(`${titleMention}\n\n` + lines.join('\n').slice(0, 3600))
        .setColor(0x4169E1)
        .setFooter({ text: `${records.length} raid(s) attended  •  Use /loot player for loot` });

      return interaction.reply({ embeds: [embed] });
    }
  },
};
