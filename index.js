/**
 * EQ Project Quarm Raid Tracker — Discord bot entry point
 *
 * Start:   node index.js
 * Deploy commands first with:  node deploy-commands.js
 */

'use strict';

require('dotenv').config();

const { Client, GatewayIntentBits, Collection } = require('discord.js');
const apiServer    = require('./lib/api-server');
const eventTracker = require('./lib/event-tracker');
const fs   = require('fs');
const path = require('path');

// ── Bot client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildScheduledEvents,
    GatewayIntentBits.GuildVoiceStates,
  ],
});

// ── Load slash commands ────────────────────────────────────────────────────
client.commands = new Collection();
const commandsDir = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
  const command = require(path.join(commandsDir, file));
  if (!command.data || !command.execute) {
    console.warn(`[WARN] ${file} is missing data or execute — skipped`);
    continue;
  }
  client.commands.set(command.data.name, command);
  console.log(`  Loaded command: /${command.data.name}`);
}

// ── Events ─────────────────────────────────────────────────────────────────
client.once('clientReady', async () => {
  console.log(`\n✅ Logged in as ${client.user.tag} (${client.user.id})`);
  console.log(`   Serving ${client.guilds.cache.size} guild(s)\n`);
  await eventTracker.init(client);
});

client.on('guildScheduledEventUpdate', (oldEvent, newEvent) => {
  eventTracker.onScheduledEventUpdate(oldEvent, newEvent).catch(err => {
    console.error('[ERROR] guildScheduledEventUpdate:', err);
  });
});

client.on('voiceStateUpdate', (oldState, newState) => {
  eventTracker.onVoiceStateUpdate(oldState, newState).catch(err => {
    console.error('[ERROR] voiceStateUpdate:', err);
  });
});

const ALLOWED_CHANNEL = process.env.CHANNEL_ID || null;

client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  if (ALLOWED_CHANNEL && interaction.channelId !== ALLOWED_CHANNEL) {
    return interaction.reply({
      content: `❌ Bot commands are only allowed in <#${ALLOWED_CHANNEL}>.`,
      flags: 64,
    });
  }

  try {
    await command.execute(interaction);

    // Auto-delete the bot's reply after 5 minutes.
    // interaction.deleteReply() silently fails for ephemeral messages, which is fine.
    setTimeout(() => interaction.deleteReply().catch(() => {}), 5 * 60 * 1000);
  } catch (err) {
    console.error(`[ERROR] /${interaction.commandName}:`, err);

    const errorMsg = { content: '❌ An unexpected error occurred. Check the bot console.', flags: 64 };
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(errorMsg).catch(() => {});
    } else {
      await interaction.reply(errorMsg).catch(() => {});
    }
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
if (!process.env.DISCORD_TOKEN) {
  console.error('❌ DISCORD_TOKEN is not set. Copy .env.example to .env and fill it in.');
  process.exit(1);
}

client.login(process.env.DISCORD_TOKEN);
apiServer.start();
