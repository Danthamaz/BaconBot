/**
 * /loot  —  Browse loot records by raid, player, or item name.
 *
 * Subcommands:
 *   /loot raid    id:<raidId>              — all loot from a raid
 *   /loot raid    id:<raidId> player:@X   — a specific person's loot from a raid
 *   /loot player  user:@Someone           — everything a Discord user has received
 *   /loot player  character:Lyri          — same, but by character name
 *   /loot item    name:<partial>          — search item history across all raids
 */

'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  getRaid,
  getRaidLoot,
  getPlayerLoot,
  searchItemLoot,
  resolveCharacterNames,
  getDiscordInfoForChar,
  getCharsForDiscordId,
  enrichWithDiscordInfo,
} = require('../lib/db');

function formatDateTime(ts) {
  return new Date(ts).toLocaleString('en-US', {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit',
  });
}

function formatTime(ts) {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' });
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('loot')
    .setDescription('View loot records')
    .addSubcommand(sub =>
      sub.setName('raid')
         .setDescription('Show loot from a specific raid (optionally filtered by player)')
         .addIntegerOption(o =>
           o.setName('id').setDescription('Raid ID').setRequired(true))
         .addUserOption(o =>
           o.setName('player').setDescription('Filter by Discord user (optional)'))
         .addStringOption(o =>
           o.setName('character').setDescription('Or filter by character name (optional)')))
    .addSubcommand(sub =>
      sub.setName('player')
         .setDescription('Show everything a player has ever looted')
         .addUserOption(o =>
           o.setName('user').setDescription('Discord user (preferred)'))
         .addStringOption(o =>
           o.setName('character').setDescription('Or look up by in-game character name')))
    .addSubcommand(sub =>
      sub.setName('item')
         .setDescription('Search for who has looted a specific item (partial name ok)')
         .addStringOption(o =>
           o.setName('name').setDescription('Item name or partial name').setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── /loot raid ────────────────────────────────────────────────────────────
    if (sub === 'raid') {
      const id          = interaction.options.getInteger('id');
      const filterUser  = interaction.options.getUser('player');
      const filterChar  = interaction.options.getString('character');
      const raid        = getRaid(id);

      if (!raid) return interaction.reply(`❌ No raid found with ID \`${id}\`.`);

      let loot = getRaidLoot(id);

      // Apply player/character filter if provided
      let filterLabel = null;
      if (filterUser || filterChar) {
        let filterChars;
        if (filterUser) {
          filterChars  = resolveCharacterNames(filterUser.id);
          filterLabel  = `<@${filterUser.id}>`;
        } else {
          const info   = getDiscordInfoForChar(filterChar);
          filterChars  = info ? resolveCharacterNames(info.discord_id) : [filterChar];
          filterLabel  = info ? `<@${info.discord_id}>` : filterChar;
        }
        const filterSet = new Set(filterChars.map(c => c.toLowerCase()));
        loot = loot.filter(l => filterSet.has(l.player_name.toLowerCase()));
      }

      if (loot.length === 0) {
        const who = filterLabel ? ` for ${filterLabel}` : '';
        return interaction.reply(`No loot records${who} for raid **${raid.name}** (#${id}).`);
      }

      const shown = loot.slice(0, 25);
      const extra = loot.length - shown.length;

      const lines = shown.map(l => {
        const info   = getDiscordInfoForChar(l.player_name);
        const who    = info ? `${l.player_name} <@${info.discord_id}>` : l.player_name;
        return `**${formatTime(l.looted_at)}** ${who} — ${l.item_name}`;
      });
      if (extra > 0) lines.push(`*… and ${extra} more item(s)*`);

      const embed = new EmbedBuilder()
        .setTitle(`💎 ${raid.name}${filterLabel ? ` — ${filterLabel}` : ''} (Loot)`)
        .setColor(0xFFD700)
        .setDescription(lines.join('\n'))
        .addFields(
          { name: '🗺️ Zone',  value: raid.zone,       inline: true },
          { name: '💎 Total', value: `${loot.length}`, inline: true },
        )
        .setFooter({ text: `Raid #${id}` });

      return interaction.reply({ embeds: [embed] });
    }

    // ── /loot player ──────────────────────────────────────────────────────────
    if (sub === 'player') {
      const discordUser = interaction.options.getUser('user');
      const charName    = interaction.options.getString('character');

      if (!discordUser && !charName) {
        return interaction.reply({
          content: '❌ Please provide either a Discord **user** mention or a **character** name.',
          ephemeral: true,
        });
      }

      // Resolve lookup term and collect display info
      let lookupTerm, allChars, titleLine;

      if (discordUser) {
        lookupTerm = discordUser.id;
        allChars   = resolveCharacterNames(discordUser.id);
        titleLine  = `<@${discordUser.id}>`;
      } else {
        const info  = getDiscordInfoForChar(charName);
        lookupTerm  = info ? info.discord_id : charName;
        allChars    = resolveCharacterNames(lookupTerm);
        titleLine   = info ? `<@${info.discord_id}>` : charName;
      }

      const isMultiChar = allChars.length > 1;
      const records     = getPlayerLoot(lookupTerm);

      if (records.length === 0) {
        const searched = isMultiChar
          ? `Searched across: ${allChars.map(c => `\`${c}\``).join(', ')}`
          : 'No records found. Double-check the spelling or link the character with `/player link`.';
        return interaction.reply(`No loot records found for ${titleLine}.\n${searched}`);
      }

      const lines = records.slice(0, 25).map(l => {
        // When multiple characters, tag which char received the item
        const charNote = isMultiChar ? ` *(${l.player_name})*` : '';
        return `• **${l.item_name}**${charNote}\n  ↳ ${l.raid_name}  •  ${formatDateTime(l.looted_at)}`;
      });
      if (records.length > 25) lines.push(`*… and ${records.length - 25} more item(s)*`);

      const charsFooter = isMultiChar ? `Characters: ${allChars.join(', ')}  •  ` : '';

      const embed = new EmbedBuilder()
        .setTitle(`💎 Loot History`)
        .setDescription(`${titleLine}\n\n` + lines.join('\n'))
        .setColor(0xFFD700)
        .setFooter({ text: `${charsFooter}${records.length} item(s) total` });

      return interaction.reply({ embeds: [embed] });
    }

    // ── /loot item ────────────────────────────────────────────────────────────
    if (sub === 'item') {
      const query   = interaction.options.getString('name');
      const records = searchItemLoot(query, 30);

      if (records.length === 0) {
        return interaction.reply(`No loot found matching **"${query}"**.`);
      }

      const lines = records.map(l => {
        // Resolve character → Discord mention if linked
        const info        = getDiscordInfoForChar(l.player_name);
        const playerLabel = info
          ? `${l.player_name} <@${info.discord_id}>`
          : l.player_name;
        return `• **${l.item_name}** → ${playerLabel}\n  ↳ ${l.raid_name}  •  ${formatDateTime(l.looted_at)}`;
      });

      const embed = new EmbedBuilder()
        .setTitle(`🔍 Item Search: "${query}"`)
        .setColor(0xAA00FF)
        .setDescription(lines.join('\n').slice(0, 3800))
        .setFooter({ text: `${records.length} result(s)` });

      return interaction.reply({ embeds: [embed] });
    }
  },
};
