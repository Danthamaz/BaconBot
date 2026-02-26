'use strict';

/**
 * /key — Track Sleeper's Tomb key holders.
 *
 * Subcommands:
 *   /key list                                    — show all key holders
 *   /key add character:Rhondaz discord_tag:Twainz — record a new holder
 *   /key remove character:Rhondaz                — remove a holder
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { addKeyHolder, removeKeyHolder, getKeyHolders } = require('../lib/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('key')
    .setDescription("Track Sleeper's Tomb key holders")
    .addSubcommand(sub =>
      sub.setName('list')
         .setDescription("Show all Sleeper's Tomb key holders"))
    .addSubcommand(sub =>
      sub.setName('add')
         .setDescription('Record a new key holder')
         .addStringOption(o =>
           o.setName('character')
            .setDescription('In-game character name')
            .setRequired(true))
         .addStringOption(o =>
           o.setName('discord_tag')
            .setDescription('Discord username or display name')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('remove')
         .setDescription('Remove a key holder')
         .addStringOption(o =>
           o.setName('character')
            .setDescription('Character name to remove')
            .setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── /key list ──────────────────────────────────────────────────────────
    if (sub === 'list') {
      const holders = getKeyHolders();

      if (holders.length === 0) {
        return interaction.reply("No Sleeper's Tomb key holders recorded yet.");
      }

      const lines = holders.map((h, i) => {
        // Prefer a Discord mention if the character is linked via player_aliases
        const who = h.discord_id ? `<@${h.discord_id}>` : `@${h.discord_tag}`;
        return `${i + 1}. **${h.character_name}** — ${who}`;
      });

      const embed = new EmbedBuilder()
        .setTitle("🗝️ Sleeper's Tomb Key Holders")
        .setColor(0x8B0000)
        .setDescription(lines.join('\n'))
        .setFooter({ text: `${holders.length} key holder(s)` });

      return interaction.reply({ embeds: [embed] });
    }

    // ── /key add ───────────────────────────────────────────────────────────
    if (sub === 'add') {
      const charName   = interaction.options.getString('character').trim();
      const discordTag = interaction.options.getString('discord_tag').trim();

      addKeyHolder(charName, discordTag);
      return interaction.reply(
        `🗝️ **${charName}** added to Sleeper's Tomb key holders (${discordTag}).`
      );
    }

    // ── /key remove ────────────────────────────────────────────────────────
    if (sub === 'remove') {
      const charName = interaction.options.getString('character').trim();
      removeKeyHolder(charName);
      return interaction.reply(`🗝️ **${charName}** removed from key holders.`);
    }
  },
};
