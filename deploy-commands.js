/**
 * Register slash commands with Discord.
 *
 * Run once (or whenever commands change):
 *   node deploy-commands.js
 *
 * Commands are registered to a specific guild (server) for instant availability.
 * To register globally (takes up to 1 hour to propagate), replace
 * Routes.applicationGuildCommands with Routes.applicationCommands.
 */

'use strict';

require('dotenv').config();

const { REST, Routes } = require('discord.js');
const fs   = require('fs');
const path = require('path');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID || !GUILD_ID) {
  console.error('❌ Missing DISCORD_TOKEN, CLIENT_ID, or GUILD_ID in .env');
  process.exit(1);
}

// Collect all command definitions
const commands = [];
const commandsDir = path.join(__dirname, 'commands');

for (const file of fs.readdirSync(commandsDir).filter(f => f.endsWith('.js'))) {
  const { data } = require(path.join(commandsDir, file));
  commands.push(data.toJSON());
  console.log(`  Queued: /${data.name}`);
}

// Deploy via REST API
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);

(async () => {
  try {
    console.log(`\nDeploying ${commands.length} command(s) to guild ${GUILD_ID}...`);

    const result = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands },
    );

    console.log(`✅ Successfully registered ${result.length} command(s).\n`);
  } catch (err) {
    console.error('❌ Deployment failed:', err);
  }
})();
