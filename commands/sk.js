'use strict';

/**
 * /sk — Suicide kings loot lists.
 *
 * Each list is an ordered roster. When loot drops, an officer awards it to the
 * highest-positioned person who is present and wants it; that winner moves to
 * the bottom and everyone else keeps their relative order. Absent players are
 * simply skipped (the officer names the winner manually), so they never lose
 * their spot. New players always join at the bottom.
 */

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../lib/db');
const { isOfficer } = require('../lib/permissions');

const SK_COLOR = 0x9B59B6;
const MAX_SHOWN = 40;

// ── Formatting helpers ──────────────────────────────────────────────────────

/** One roster line: 1. **Char** — @mention (crown on the top spot). */
function entryLine(e) {
  const who = e.discord_id ? ` — <@${e.discord_id}>` : '';
  const crown = e.position === 1 ? ' 👑' : '';
  return `${e.position}. **${e.character_name}**${who}${crown}`;
}

/** Embed showing a full list in order. */
function listEmbed(list, entries) {
  const lines = entries.slice(0, MAX_SHOWN).map(entryLine);
  if (entries.length > MAX_SHOWN) lines.push(`… and ${entries.length - MAX_SHOWN} more`);
  return new EmbedBuilder()
    .setTitle(`👑 Suicide Kings: ${list.name}`)
    .setColor(SK_COLOR)
    .setDescription(lines.length ? lines.join('\n') : '_Empty — officers can add people with `/sk add`._')
    .setFooter({ text: `${entries.length} entr(ies)  •  winner moves to the bottom` });
}

// ── Slash command definition ───────────────────────────────────────────────

const listOption = o => o.setName('list').setDescription('Suicide kings list name').setRequired(true).setAutocomplete(true);

const data = new SlashCommandBuilder()
  .setName('sk')
  .setDescription('Suicide kings loot lists')
  .addSubcommand(sub =>
    sub.setName('show')
      .setDescription('Show a suicide kings list in order')
      .addStringOption(listOption)
  )
  .addSubcommand(sub =>
    sub.setName('lists')
      .setDescription('Show all suicide kings lists')
  )
  .addSubcommand(sub =>
    sub.setName('history')
      .setDescription('Recent awards on a list')
      .addStringOption(listOption)
      .addIntegerOption(o => o.setName('limit').setDescription('Number of entries (1-25)').setMinValue(1).setMaxValue(25))
  )
  .addSubcommand(sub =>
    sub.setName('create')
      .setDescription('Create a new suicide kings list (officers)')
      .addStringOption(o => o.setName('name').setDescription('List name, e.g. "ethereal"').setRequired(true).setMaxLength(50))
  )
  .addSubcommand(sub =>
    sub.setName('delete')
      .setDescription('Delete a suicide kings list and its history (officers)')
      .addStringOption(listOption)
  )
  .addSubcommand(sub =>
    sub.setName('add')
      .setDescription('Add a character to the bottom of a list (officers)')
      .addStringOption(listOption)
      .addStringOption(o => o.setName('character').setDescription('In-game character name').setRequired(true).setAutocomplete(true))
  )
  .addSubcommand(sub =>
    sub.setName('remove')
      .setDescription('Remove a character from a list (officers)')
      .addStringOption(listOption)
      .addStringOption(o => o.setName('character').setDescription('Character to remove').setRequired(true).setAutocomplete(true))
  )
  .addSubcommand(sub =>
    sub.setName('award')
      .setDescription('Award loot: the winner moves to the bottom (officers)')
      .addStringOption(listOption)
      .addStringOption(o => o.setName('character').setDescription('Who won the item').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('item').setDescription('What they won'))
  )
  .addSubcommand(sub =>
    sub.setName('undo')
      .setDescription('Revert the most recent award on a list (officers)')
      .addStringOption(listOption)
  )
  .addSubcommand(sub =>
    sub.setName('shuffle')
      .setDescription('Randomize the order of a list — for fair initial seeding (officers)')
      .addStringOption(listOption)
  );

// ── Autocomplete ───────────────────────────────────────────────────────────

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);

  if (focused.name === 'list') {
    const lists = db.searchSkLists(focused.value);
    return interaction.respond(lists.map(l => ({ name: l.name, value: l.name })));
  }

  if (focused.name === 'character') {
    const sub = interaction.options.getSubcommand();
    if (sub === 'add') {
      const names = db.searchAliasCharacters(focused.value);
      return interaction.respond(names.map(n => ({ name: n, value: n })));
    }
    // award / remove: suggest only characters already on the chosen list
    const listName = interaction.options.getString('list');
    const list = listName ? db.getSkList(listName) : null;
    if (!list) return interaction.respond([]);
    const term = focused.value.toLowerCase();
    const entries = db.getSkEntries(list.id)
      .filter(e => e.character_name.toLowerCase().startsWith(term))
      .slice(0, 25);
    return interaction.respond(entries.map(e => ({
      name: `${e.position}. ${e.character_name}`,
      value: e.character_name,
    })));
  }

  return interaction.respond([]);
}

// ── Execute ────────────────────────────────────────────────────────────────

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'show':    return handleShow(interaction);
    case 'lists':   return handleLists(interaction);
    case 'history': return handleHistory(interaction);
    case 'create':  return handleCreate(interaction);
    case 'delete':  return handleDelete(interaction);
    case 'add':     return handleAdd(interaction);
    case 'remove':  return handleRemove(interaction);
    case 'award':   return handleAward(interaction);
    case 'undo':    return handleUndo(interaction);
    case 'shuffle': return handleShuffle(interaction);
    default: return interaction.reply({ content: '❌ Unknown subcommand.', flags: 64 });
  }
}

/** Resolve the list option to a row, or reply with an error and return null. */
function requireList(interaction) {
  const name = interaction.options.getString('list').trim();
  const list = db.getSkList(name);
  if (!list) {
    interaction.reply({ content: `❌ No suicide kings list named **${name}**. See \`/sk lists\`.`, flags: 64 });
    return null;
  }
  return list;
}

/** Officer gate; replies with a refusal and returns false when not allowed. */
function requireOfficer(interaction, action) {
  if (isOfficer(interaction.member)) return true;
  interaction.reply({ content: `❌ Only officers can ${action}.`, flags: 64 });
  return false;
}

// ── Subcommand handlers ────────────────────────────────────────────────────

async function handleShow(interaction) {
  const list = requireList(interaction);
  if (!list) return;
  return interaction.reply({ embeds: [listEmbed(list, db.getSkEntries(list.id))] });
}

async function handleLists(interaction) {
  const lists = db.getSkLists();
  if (lists.length === 0) {
    return interaction.reply('📭 No suicide kings lists yet. Officers can create one with `/sk create`.');
  }
  const lines = lists.map(l => `**${l.name}** — ${l.entry_count} entr(ies)  •  created <t:${Math.floor(l.created_at / 1000)}:R>`);
  const embed = new EmbedBuilder()
    .setTitle('👑 Suicide Kings Lists')
    .setColor(SK_COLOR)
    .setDescription(lines.join('\n'));
  return interaction.reply({ embeds: [embed] });
}

async function handleHistory(interaction) {
  const list = requireList(interaction);
  if (!list) return;
  const limit = interaction.options.getInteger('limit') ?? 10;

  const awards = db.getSkAwardHistory(list.id, limit);
  if (awards.length === 0) {
    return interaction.reply(`📭 No awards recorded on **${list.name}** yet.`);
  }

  const lines = awards.map(a => {
    const item = a.item_name ? ` — **${a.item_name}**` : '';
    const by = a.awarded_by ? ` by <@${a.awarded_by}>` : '';
    return `👑 **${a.character_name}**${item} • <t:${Math.floor(a.awarded_at / 1000)}:R>${by}`;
  });

  const embed = new EmbedBuilder()
    .setTitle(`📜 Award History: ${list.name}`)
    .setColor(SK_COLOR)
    .setDescription(lines.join('\n'))
    .setFooter({ text: `${awards.length} award(s), newest first` });
  return interaction.reply({ embeds: [embed] });
}

async function handleCreate(interaction) {
  if (!requireOfficer(interaction, 'create suicide kings lists')) return;

  const name = interaction.options.getString('name').trim();
  if (db.getSkList(name)) {
    return interaction.reply({ content: `❌ A list named **${name}** already exists.`, flags: 64 });
  }

  db.createSkList(name, interaction.user.id);
  return interaction.reply(`👑 Created suicide kings list **${name}**. Add people with \`/sk add list:${name}\`, then \`/sk shuffle list:${name}\` for a fair starting order.`);
}

async function handleDelete(interaction) {
  if (!requireOfficer(interaction, 'delete suicide kings lists')) return;
  const list = requireList(interaction);
  if (!list) return;

  const count = db.getSkEntries(list.id).length;
  db.deleteSkList(list.id);
  return interaction.reply(`🗑️ Deleted list **${list.name}** (${count} entr(ies) and its award history).`);
}

async function handleAdd(interaction) {
  if (!requireOfficer(interaction, 'manage suicide kings lists')) return;
  const list = requireList(interaction);
  if (!list) return;

  const character = interaction.options.getString('character').trim();
  if (db.getSkEntry(list.id, character)) {
    return interaction.reply({ content: `❌ **${character}** is already on **${list.name}**.`, flags: 64 });
  }

  // One slot per person: block alts of someone already on the list.
  for (const alt of db.resolveCharacterNames(character)) {
    const existing = db.getSkEntry(list.id, alt);
    if (existing) {
      return interaction.reply({
        content: `❌ That player is already on **${list.name}** as **${existing.character_name}** (position ${existing.position}).`,
        flags: 64,
      });
    }
  }

  const pos = db.addSkEntry(list.id, character, interaction.user.id);
  return interaction.reply(`👑 Added **${character}** to **${list.name}** at position **${pos}** (bottom).`);
}

async function handleRemove(interaction) {
  if (!requireOfficer(interaction, 'manage suicide kings lists')) return;
  const list = requireList(interaction);
  if (!list) return;

  const character = interaction.options.getString('character').trim();
  if (!db.removeSkEntry(list.id, character)) {
    return interaction.reply({ content: `❌ **${character}** is not on **${list.name}**.`, flags: 64 });
  }
  return interaction.reply(`👑 Removed **${character}** from **${list.name}**. Everyone below moved up one spot.`);
}

async function handleAward(interaction) {
  if (!requireOfficer(interaction, 'award suicide kings loot')) return;
  const list = requireList(interaction);
  if (!list) return;

  const character = interaction.options.getString('character').trim();
  const item = interaction.options.getString('item')?.trim() || null;

  const result = db.awardSkItem(list.id, character, item, interaction.user.id);
  if (!result) {
    return interaction.reply({ content: `❌ **${character}** is not on **${list.name}**.`, flags: 64 });
  }

  const entries = db.getSkEntries(list.id);
  const nextUp = entries.slice(0, 5).map(entryLine).join('\n');

  const embed = new EmbedBuilder()
    .setTitle(`👑 ${result.characterName} wins!`)
    .setColor(SK_COLOR)
    .setDescription(
      `${item ? `**${item}** goes to ` : ''}**${result.characterName}** — ` +
      `moved from position **${result.oldPosition}** to the bottom (**${result.newPosition}**).`
    )
    .addFields({ name: 'Next up', value: nextUp || '_List is empty_' })
    .setFooter({ text: `Mistake? /sk undo list:${list.name}` });

  return interaction.reply({ embeds: [embed] });
}

async function handleUndo(interaction) {
  if (!requireOfficer(interaction, 'undo suicide kings awards')) return;
  const list = requireList(interaction);
  if (!list) return;

  const award = db.undoSkAward(list.id);
  if (!award) {
    return interaction.reply({ content: `❌ No awards to undo on **${list.name}**.`, flags: 64 });
  }

  const item = award.item_name ? ` (**${award.item_name}**)` : '';
  return interaction.reply(
    `↩️ Reverted the last award on **${list.name}**: **${award.character_name}**${item} is back at position **${award.old_position}**.`
  );
}

async function handleShuffle(interaction) {
  if (!requireOfficer(interaction, 'shuffle suicide kings lists')) return;
  const list = requireList(interaction);
  if (!list) return;

  db.shuffleSkList(list.id);
  const entries = db.getSkEntries(list.id);
  return interaction.reply({
    content: `🎲 Shuffled **${list.name}** into a random order.`,
    embeds: [listEmbed(list, entries)],
  });
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = { data, execute, autocomplete };
