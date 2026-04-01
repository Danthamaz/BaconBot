'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ping')
    .setDescription('Check bot connection info'),

  async execute(interaction) {
    const sent = await interaction.reply({ content: 'Pinging...', fetchReply: true });
    const roundtrip = sent.createdTimestamp - interaction.createdTimestamp;
    const ws = interaction.client.ws.ping;
    const uptime = process.uptime();

    const days = Math.floor(uptime / 86400);
    const hours = Math.floor((uptime % 86400) / 3600);
    const minutes = Math.floor((uptime % 3600) / 60);
    const uptimeStr = `${days}d ${hours}h ${minutes}m`;

    const embed = new EmbedBuilder()
      .setTitle('Pong!')
      .setColor(0x8B0000)
      .addFields(
        { name: 'Roundtrip', value: `${roundtrip}ms`, inline: true },
        { name: 'WebSocket', value: `${ws}ms`, inline: true },
        { name: 'Uptime', value: uptimeStr, inline: true },
      )
      .setTimestamp();

    await interaction.editReply({ content: null, embeds: [embed] });
  },
};
