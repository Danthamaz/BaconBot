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
const db           = require('./lib/db');
const fs   = require('fs');
const path = require('path');

// ── Bot client ─────────────────────────────────────────────────────────────
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
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
async function purgeOldMessages(channel, botOnly = false) {
  try {
    const cutoff   = Date.now() - 5 * 60 * 1000;
    const messages = await channel.messages.fetch({ limit: 100 });
    const toDelete = messages.filter(m => !m.pinned && m.createdTimestamp < cutoff
      && (!botOnly || m.author.id === client.user.id));
    if (toDelete.size === 0) return;
    // bulkDelete requires 2+ messages; fall back to individual deletes for single messages
    if (toDelete.size === 1) {
      await toDelete.first().delete();
    } else {
      await channel.bulkDelete(toDelete, true);
    }
  } catch (err) {
    console.error('[Purge] Error:', err);
  }
}

client.once('clientReady', async () => {
  console.log(`\n✅ Logged in as ${client.user.tag} (${client.user.id})`);
  console.log(`   Serving ${client.guilds.cache.size} guild(s)\n`);
  await eventTracker.init(client);

  // Auto-delete unpinned messages older than 5 minutes in designated channels
  for (const { id, botOnly } of AUTO_DELETE_CHANNELS) {
    const ch = await client.channels.fetch(id).catch(() => null);
    if (ch) {
      purgeOldMessages(ch, botOnly);
      setInterval(() => purgeOldMessages(ch, botOnly), 60 * 1000);
    }
  }
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

// Bot is only allowed in 'bacon-bot' channel
const ALLOWED_CHANNEL = process.env.CHANNEL_ID || null;

// Channels where unpinned messages are auto-deleted after 5 minutes
// botOnly: true = only delete messages from this bot
const AUTO_DELETE_CHANNELS = [
  { id: '1464353128022278154', botOnly: true },
  { id: '1476650458918555680', botOnly: false },
];

client.on('interactionCreate', async interaction => {
  // Handle autocomplete interactions
  if (interaction.isAutocomplete()) {
    const command = client.commands.get(interaction.commandName);
    if (command?.autocomplete) await command.autocomplete(interaction);
    return;
  }

  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  const allowedChannels = new Set(
    [ALLOWED_CHANNEL, ...(command.extraChannels ?? [])].filter(Boolean)
  );
  if (ALLOWED_CHANNEL && !allowedChannels.has(interaction.channelId)) {
    return interaction.reply({
      content: `❌ Bot commands are only allowed in <#${ALLOWED_CHANNEL}>.`,
      flags: 64,
    });
  }

  try {
    await command.execute(interaction);
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
apiServer.start(client);

// ── Graceful shutdown (checkpoint SQLite WAL) ─────────────────────────────
function shutdown(signal) {
  console.log(`\n${signal} received — shutting down…`);
  client.destroy();
  db.closeDb();
  process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
