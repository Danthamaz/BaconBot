'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Show all available bot commands'),

  async execute(interaction) {
    const fields = [
      {
        name: '📋 /raids',
        value: [
          '`list [page]` — browse recorded raids',
          '`info id:<id>` — full details for a raid',
          '`edit id:<id> [name] [zone] [date] [start_time] [end_time]` — update a raid',
          '`delete id:<id>` — permanently delete a raid',
        ].join('\n'),
      },
      {
        name: '📊 /attendance',
        value: [
          '`raid id:<id>` — who attended a specific raid',
          '`player [user] [character]` — full attendance history for a player',
        ].join('\n'),
      },
      {
        name: '🎁 /loot',
        value: [
          '`raid id:<id> [player] [character]` — loot from a specific raid',
          '`player [user] [character]` — everything a player has ever looted',
          '`item name:<partial>` — search who looted an item by name',
        ].join('\n'),
      },
      {
        name: '🗝️ /key',
        value: [
          "`list` — show all Sleeper's Tomb key holders",
          '`add character:<name> discord_tag:<tag>` — record a new key holder',
          '`remove character:<name>` — remove a key holder',
        ].join('\n'),
      },
      {
        name: '🎮 /player',
        value: [
          '`link character:<name> [user]` — link an in-game character to a Discord account',
          '`unlink character:<name>` — remove a character link',
          '`chars [user]` — list all characters linked to a Discord account',
          '`whois character:<name>` — find which Discord user owns a character',
        ].join('\n'),
      },
      {
        name: '📂 /parse',
        value: [
          '`[name] [zone] [date] [start_time] [end_time] [character]`',
          '`[logfile] [filepath] [raid_id]`',
          'Parse an EQ log file and record (or merge into) a raid. Attach a log file or provide a server path.',
        ].join('\n'),
      },
    ];

    const embed = new EmbedBuilder()
      .setTitle('🥓 BaconBot — Command Reference')
      .setColor(0x4169E1)
      .setFields(fields)
      .setFooter({ text: 'All replies auto-delete after 5 minutes.' });

    return interaction.reply({ embeds: [embed] });
  },
};
