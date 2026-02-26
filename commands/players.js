/**
 * /player  —  Link in-game characters to Discord accounts.
 *
 * No concept of a "main" — Discord profile IS the identity.
 * Any character can be linked to any Discord user; queries then
 * aggregate attendance and loot across all linked characters automatically.
 *
 * Subcommands:
 *   /player link   character:Lyri                     — link Lyri to yourself
 *   /player link   character:Lyrimage user:@Someone   — officer links another's alt
 *   /player unlink character:Lyrimage                 — remove a character link
 *   /player chars                                      — list your own characters
 *   /player chars  user:@Someone                      — list someone else's characters
 *   /player whois  character:Lyrimage                 — who does this character belong to?
 */

'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const {
  linkCharacter,
  unlinkCharacter,
  getCharsForDiscordId,
  getDiscordInfoForChar,
} = require('../lib/db');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('player')
    .setDescription('Link in-game characters to Discord accounts')
    .addSubcommand(sub =>
      sub.setName('link')
         .setDescription('Link an in-game character to a Discord account')
         .addStringOption(o =>
           o.setName('character')
            .setDescription('In-game character name, e.g. "Lyri"')
            .setRequired(true))
         .addUserOption(o =>
           o.setName('user')
            .setDescription('Discord user to link to (defaults to you)')))
    .addSubcommand(sub =>
      sub.setName('unlink')
         .setDescription('Remove an in-game character\'s Discord link')
         .addStringOption(o =>
           o.setName('character')
            .setDescription('Character name to unlink')
            .setRequired(true)))
    .addSubcommand(sub =>
      sub.setName('chars')
         .setDescription('List all in-game characters linked to a Discord account')
         .addUserOption(o =>
           o.setName('user')
            .setDescription('Discord user to look up (defaults to you)')))
    .addSubcommand(sub =>
      sub.setName('whois')
         .setDescription('Find out which Discord user owns an in-game character')
         .addStringOption(o =>
           o.setName('character')
            .setDescription('Character name to look up')
            .setRequired(true))),

  async execute(interaction) {
    const sub = interaction.options.getSubcommand();

    // ── /player link ─────────────────────────────────────────────────────────
    if (sub === 'link') {
      const charName  = interaction.options.getString('character').trim();
      // If no user is specified, link to the person running the command
      const target    = interaction.options.getUser('user') ?? interaction.user;

      // Check if this character is already linked to someone else
      const existing = getDiscordInfoForChar(charName);
      if (existing && existing.discord_id !== target.id) {
        return interaction.reply({
          content:
            `⚠️ **${charName}** is already linked to <@${existing.discord_id}> (${existing.discord_tag}).\n` +
            `Use \`/player unlink character:${charName}\` first if you need to reassign it.`,
          ephemeral: true,
        });
      }

      linkCharacter(charName, target.id, target.username);

      // Show the user's full updated character list
      const allChars = getCharsForDiscordId(target.id);
      const isSelf   = target.id === interaction.user.id;

      return interaction.reply(
        `✅ **${charName}** is now linked to ${isSelf ? 'your' : `<@${target.id}>'s`} Discord account.\n\n` +
        `All characters for <@${target.id}>: ${allChars.map(c => `\`${c}\``).join(', ')}\n\n` +
        `Queries like \`/attendance player\` and \`/loot player\` will now aggregate across all of the above.`
      );
    }

    // ── /player unlink ───────────────────────────────────────────────────────
    if (sub === 'unlink') {
      const charName = interaction.options.getString('character').trim();
      const existing = getDiscordInfoForChar(charName);

      if (!existing) {
        return interaction.reply({
          content: `⚠️ **${charName}** isn't linked to any Discord account — nothing to unlink.`,
          ephemeral: true,
        });
      }

      // Only allow unlinking your own characters, unless linking someone else's
      // (no special permission check here — add role checks if desired)
      unlinkCharacter(charName);

      return interaction.reply(
        `🔗 **${charName}** has been unlinked from <@${existing.discord_id}>.\n` +
        `Historical records are unchanged — only future queries are affected.`
      );
    }

    // ── /player chars ─────────────────────────────────────────────────────────
    if (sub === 'chars') {
      const target   = interaction.options.getUser('user') ?? interaction.user;
      const chars    = getCharsForDiscordId(target.id);
      const isSelf   = target.id === interaction.user.id;

      if (chars.length === 0) {
        const who = isSelf ? 'You have' : `<@${target.id}> has`;
        return interaction.reply({
          content:
            `${who} no characters linked yet.\n` +
            `Use \`/player link character:<name>\`${isSelf ? '' : ` user:<@${target.id}>`} to add one.`,
          ephemeral: isSelf,
        });
      }

      const embed = new EmbedBuilder()
        .setTitle(`🎮 ${target.username}'s Characters`)
        .setColor(0x4169E1)
        .setDescription(chars.map(c => `• \`${c}\``).join('\n'))
        .setThumbnail(target.displayAvatarURL())
        .setFooter({
          text: `${chars.length} character(s)  •  Use /attendance player or /loot player to view records`,
        });

      return interaction.reply({ embeds: [embed] });
    }

    // ── /player whois ─────────────────────────────────────────────────────────
    if (sub === 'whois') {
      const charName = interaction.options.getString('character').trim();
      const info     = getDiscordInfoForChar(charName);

      if (!info) {
        return interaction.reply(
          `❓ **${charName}** isn't linked to any Discord account.\n` +
          `The player can run \`/player link character:${charName}\` to claim it.`
        );
      }

      const allChars = getCharsForDiscordId(info.discord_id);

      return interaction.reply(
        `**${charName}** belongs to <@${info.discord_id}>.\n` +
        `All their characters: ${allChars.map(c => `\`${c}\``).join(', ')}`
      );
    }

  },
};
