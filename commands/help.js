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
          '`name zone date start_time end_time character logfile [raid_id]`',
          'Attach your EQ log `.txt` file (25 MB Discord limit).',
          '**Large logs:** trim to the session first using Notepad++ or:',
          '`Select-String -Path eqlog.txt -Pattern "^\\[" | Where-Object { $_.Line -ge "[Mon Jan 01]" } | Set-Content trimmed.txt`',
        ].join('\n'),
      },
      {
        name: '💀 /tod',
        value: [
          '`record mob:<name> time:<now|timestamp>` — record a Time of Death',
          '`status` — show current ToD windows for all tracked mobs',
          '`history mob:<name>` — view ToD history for a specific mob',
          '`undo mob:<name>` — remove the most recent ToD entry',
          '`mob-add name:<name> lockout:<duration>` — add a new tracked mob',
          '`mob-edit name:<name> [new_name] [lockout]` — edit a tracked mob',
          '`mob-remove name:<name>` — remove a tracked mob',
        ].join('\n'),
      },
      {
        name: '🏦 /bank',
        value: [
          '`view [mule] [page]` — browse the guild bank inventory',
          '`search item:<partial> [mule]` — find an item in the bank',
          '`history [item] [mule] [limit]` — recent deposits/withdrawals',
          '`mules` — list bank mule characters',
          '`deposit item qty [mule] [player] [note]` — record a deposit *(officers)*',
          '`withdraw item qty [mule] [player] [note]` — record a withdrawal *(officers)*',
          '`note item mule [text]` — set/clear a persistent item note *(officers)*',
          '`undo id:<id>` — remove a mistaken transaction *(officers)*',
        ].join('\n'),
      },
      {
        name: '🏓 /ping',
        value: [
          '`/ping` — check bot roundtrip latency, WebSocket latency, and uptime',
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
