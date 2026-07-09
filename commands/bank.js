'use strict';

const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const db = require('../lib/db');

const BANK_COLOR = 0x1ABC9C;
const PAGE_SIZE = 15;

// ── Officer role check ──────────────────────────────────────────────────

const OFFICER_ROLE_IDS = (process.env.OFFICER_ROLE_IDS || '')
  .split(',').map(s => s.trim()).filter(Boolean);

function isOfficer(member) {
  if (OFFICER_ROLE_IDS.length === 0) return true; // no roles configured = unrestricted
  return OFFICER_ROLE_IDS.some(id => member.roles.cache.has(id));
}

// ── Formatting helpers ──────────────────────────────────────────────────────

/** One inventory line: **Item** ×qty — _Mule_ 📝 note */
function inventoryLine(row) {
  const note = row.note ? `  📝 ${row.note}` : '';
  return `**${row.item_name}** ×${row.qty} — _${row.mule}_${note}`;
}

/** One ledger line: [#id] ➕/➖ qty× Item — Mule • when by who (player) note */
function historyLine(tx) {
  const icon = tx.type === 'deposit' ? '➕' : '➖';
  const unix = Math.floor(tx.recorded_at / 1000);
  const by = tx.recorded_by ? ` by <@${tx.recorded_by}>` : '';
  const player = tx.player_name ? ` (${tx.type === 'deposit' ? 'from' : 'to'} ${tx.player_name})` : '';
  const note = tx.note ? `\n↳ 📝 ${tx.note.length > 60 ? tx.note.slice(0, 60) + '…' : tx.note}` : '';
  return `\`[#${tx.id}]\` ${icon} ${tx.quantity}× **${tx.item_name}** — _${tx.mule}_ • <t:${unix}:R>${by}${player}${note}`;
}

/**
 * Resolve which mule a deposit should go to when the option is omitted.
 * Returns { mule } or { error } with a user-facing message.
 */
function resolveDepositMule(muleOpt) {
  if (muleOpt) return { mule: muleOpt };
  const mules = db.getBankMules();
  if (mules.length === 1) return { mule: mules[0].mule };
  if (mules.length === 0) {
    return { error: '❌ No bank mules exist yet — specify `mule:` to create the first one.' };
  }
  return { error: `❌ Multiple bank mules exist (${mules.map(m => `**${m.mule}**`).join(', ')}) — specify \`mule:\`.` };
}

/**
 * Resolve which mule a withdrawal should come from when the option is omitted.
 * Returns { mule } or { error } with a user-facing message.
 */
function resolveWithdrawMule(itemName, muleOpt) {
  if (muleOpt) return { mule: muleOpt };
  const holdings = db.getBankItemHoldings(itemName);
  if (holdings.length === 1) return { mule: holdings[0].mule };
  if (holdings.length === 0) {
    return { error: `❌ **${itemName}** is not in the bank.` };
  }
  const list = holdings.map(h => `**${h.mule}** (×${h.qty})`).join(', ');
  return { error: `❌ **${itemName}** is held by multiple mules: ${list} — specify \`mule:\`.` };
}

// ── Slash command definition ───────────────────────────────────────────────

const data = new SlashCommandBuilder()
  .setName('bank')
  .setDescription('Guild bank inventory and transaction ledger')
  .addSubcommand(sub =>
    sub.setName('view')
      .setDescription('Browse the guild bank inventory')
      .addStringOption(o => o.setName('mule').setDescription('Only show items on this mule').setAutocomplete(true))
      .addIntegerOption(o => o.setName('page').setDescription('Page number').setMinValue(1))
  )
  .addSubcommand(sub =>
    sub.setName('search')
      .setDescription('Search the bank for an item')
      .addStringOption(o => o.setName('item').setDescription('Item name (partial ok)').setRequired(true))
      .addStringOption(o => o.setName('mule').setDescription('Only search this mule').setAutocomplete(true))
  )
  .addSubcommand(sub =>
    sub.setName('history')
      .setDescription('Recent bank deposits and withdrawals')
      .addStringOption(o => o.setName('item').setDescription('Filter by item').setAutocomplete(true))
      .addStringOption(o => o.setName('mule').setDescription('Filter by mule').setAutocomplete(true))
      .addIntegerOption(o => o.setName('limit').setDescription('Number of entries (1-25)').setMinValue(1).setMaxValue(25))
  )
  .addSubcommand(sub =>
    sub.setName('mules')
      .setDescription('List bank mule characters')
  )
  .addSubcommand(sub =>
    sub.setName('deposit')
      .setDescription('Record items given to the bank (officers)')
      .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true))
      .addIntegerOption(o => o.setName('qty').setDescription('Quantity').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('mule').setDescription('Bank mule holding the item').setAutocomplete(true))
      .addStringOption(o => o.setName('player').setDescription('Who donated the item'))
      .addStringOption(o => o.setName('note').setDescription('Note on this transaction'))
  )
  .addSubcommand(sub =>
    sub.setName('withdraw')
      .setDescription('Record items taken out of the bank (officers)')
      .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
      .addIntegerOption(o => o.setName('qty').setDescription('Quantity').setRequired(true).setMinValue(1))
      .addStringOption(o => o.setName('mule').setDescription('Bank mule the item came from').setAutocomplete(true))
      .addStringOption(o => o.setName('player').setDescription('Who received the item'))
      .addStringOption(o => o.setName('note').setDescription('Note on this transaction'))
  )
  .addSubcommand(sub =>
    sub.setName('note')
      .setDescription('Set or clear a persistent note on a bank item (officers)')
      .addStringOption(o => o.setName('item').setDescription('Item name').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('mule').setDescription('Bank mule holding the item').setRequired(true).setAutocomplete(true))
      .addStringOption(o => o.setName('text').setDescription('Note text — omit to clear the existing note'))
  )
  .addSubcommand(sub =>
    sub.setName('undo')
      .setDescription('Remove a mistaken bank transaction by id (officers)')
      .addIntegerOption(o => o.setName('id').setDescription('Transaction id (shown in /bank history)').setRequired(true))
  );

// ── Autocomplete ───────────────────────────────────────────────────────────

async function autocomplete(interaction) {
  const focused = interaction.options.getFocused(true);
  if (focused.name === 'mule') {
    const term = focused.value.toLowerCase();
    const mules = db.getBankMules()
      .filter(m => m.mule.toLowerCase().startsWith(term))
      .slice(0, 25);
    return interaction.respond(mules.map(m => ({ name: m.mule, value: m.mule })));
  }
  const items = db.searchBankItems(focused.value);
  return interaction.respond(items.map(name => ({ name, value: name })));
}

// ── Execute ────────────────────────────────────────────────────────────────

async function execute(interaction) {
  const sub = interaction.options.getSubcommand();

  switch (sub) {
    case 'view':     return handleView(interaction);
    case 'search':   return handleSearch(interaction);
    case 'history':  return handleHistory(interaction);
    case 'mules':    return handleMules(interaction);
    case 'deposit':  return handleDepositWithdraw(interaction, 'deposit');
    case 'withdraw': return handleDepositWithdraw(interaction, 'withdraw');
    case 'note':     return handleNote(interaction);
    case 'undo':     return handleUndo(interaction);
    default: return interaction.reply({ content: '❌ Unknown subcommand.', flags: 64 });
  }
}

// ── Subcommand handlers ────────────────────────────────────────────────────

async function handleView(interaction) {
  const mule = interaction.options.getString('mule') || null;
  const page = (interaction.options.getInteger('page') ?? 1) - 1;

  const offset = page * PAGE_SIZE;
  const rows  = db.getBankInventory({ mule, limit: PAGE_SIZE, offset });
  const total = db.getBankInventoryCount({ mule });

  if (rows.length === 0) {
    return interaction.reply(
      total === 0
        ? mule
          ? `📭 No items in the bank on **${mule}**.`
          : '📭 The guild bank is empty. Officers can add items with `/bank deposit`.'
        : '📭 No more items on this page.'
    );
  }

  const totalPages = Math.ceil(total / PAGE_SIZE);
  const embed = new EmbedBuilder()
    .setTitle('🏦 Guild Bank')
    .setColor(BANK_COLOR)
    .setDescription(rows.map(inventoryLine).join('\n'))
    .setFooter({ text: [
      `Page ${page + 1} of ${totalPages}  •  ${total} stack(s)`,
      mule ? `mule: ${mule}` : null,
    ].filter(Boolean).join('  •  ') });

  return interaction.reply({ embeds: [embed] });
}

async function handleSearch(interaction) {
  const item = interaction.options.getString('item');
  const mule = interaction.options.getString('mule') || null;

  const rows = db.getBankInventory({ item, mule, limit: 25 });
  if (rows.length === 0) {
    return interaction.reply(`📭 Nothing in the bank matching **${item}**${mule ? ` on **${mule}**` : ''}.`);
  }

  const embed = new EmbedBuilder()
    .setTitle(`🔍 Bank Search: ${item}`)
    .setColor(BANK_COLOR)
    .setDescription(rows.map(inventoryLine).join('\n'))
    .setFooter({ text: `${rows.length} match(es)${mule ? `  •  mule: ${mule}` : ''}` });

  return interaction.reply({ embeds: [embed] });
}

async function handleHistory(interaction) {
  const item  = interaction.options.getString('item') || null;
  const mule  = interaction.options.getString('mule') || null;
  const limit = interaction.options.getInteger('limit') ?? 10;

  const txs = db.getBankHistory({ item, mule, limit });
  if (txs.length === 0) {
    return interaction.reply('📭 No bank transactions recorded yet.');
  }

  const filterLabel = [
    item ? `item: ${item}` : null,
    mule ? `mule: ${mule}` : null,
  ].filter(Boolean).join('  •  ');

  const embed = new EmbedBuilder()
    .setTitle('📜 Bank History')
    .setColor(BANK_COLOR)
    .setDescription(txs.map(historyLine).join('\n'))
    .setFooter({ text: [`${txs.length} entr(ies)`, filterLabel || null].filter(Boolean).join('  •  ') });

  return interaction.reply({ embeds: [embed] });
}

async function handleMules(interaction) {
  const mules = db.getBankMules();
  if (mules.length === 0) {
    return interaction.reply('📭 No bank mules recorded yet. Officers can add one with `/bank deposit`.');
  }

  const lines = mules.map(m => {
    const unix = Math.floor(m.last_activity / 1000);
    return `**${m.mule}** — ${m.item_count} item(s)  •  last activity <t:${unix}:R>`;
  });

  const embed = new EmbedBuilder()
    .setTitle('🐴 Bank Mules')
    .setColor(BANK_COLOR)
    .setDescription(lines.join('\n'));

  return interaction.reply({ embeds: [embed] });
}

async function handleDepositWithdraw(interaction, type) {
  if (!isOfficer(interaction.member)) {
    return interaction.reply({ content: '❌ Only officers can record bank transactions.', flags: 64 });
  }

  const item   = interaction.options.getString('item').trim();
  const qty    = interaction.options.getInteger('qty');
  const player = interaction.options.getString('player') || null;
  const note   = interaction.options.getString('note') || null;

  const resolved = type === 'deposit'
    ? resolveDepositMule(interaction.options.getString('mule'))
    : resolveWithdrawMule(item, interaction.options.getString('mule'));
  if (resolved.error) {
    return interaction.reply({ content: resolved.error, flags: 64 });
  }
  const mule = resolved.mule;

  if (type === 'withdraw') {
    const available = db.getBankItemQuantity(item, mule);
    if (qty > available) {
      const others = db.getBankItemHoldings(item).filter(h => h.mule.toLowerCase() !== mule.toLowerCase());
      const extra = others.length
        ? `\nAlso held by: ${others.map(h => `**${h.mule}** (×${h.qty})`).join(', ')}`
        : '';
      return interaction.reply({
        content: `❌ Only **${available}** × **${item}** on **${mule}** — cannot withdraw ${qty}.${extra}`,
        flags: 64,
      });
    }
  }

  const txId = db.recordBankTransaction({
    itemName: item, quantity: qty, type, mule, playerName: player, note,
    recordedBy: interaction.user.id,
  });
  const newTotal = db.getBankItemQuantity(item, mule);

  const isDeposit = type === 'deposit';
  const embed = new EmbedBuilder()
    .setTitle(isDeposit ? '🏦 Deposit Recorded' : '🏦 Withdrawal Recorded')
    .setColor(BANK_COLOR)
    .addFields(
      { name: 'Item', value: `${qty}× **${item}**`, inline: true },
      { name: 'Mule', value: mule, inline: true },
      { name: 'Now Holding', value: `×${newTotal}`, inline: true },
    )
    .setFooter({ text: `Transaction #${txId} — undo with /bank undo id:${txId}` });

  if (player) embed.addFields({ name: isDeposit ? 'Donated By' : 'Given To', value: player, inline: true });
  if (note)   embed.addFields({ name: 'Note', value: note });

  return interaction.reply({ embeds: [embed] });
}

async function handleNote(interaction) {
  if (!isOfficer(interaction.member)) {
    return interaction.reply({ content: '❌ Only officers can edit bank notes.', flags: 64 });
  }

  const item = interaction.options.getString('item').trim();
  const mule = interaction.options.getString('mule');
  const text = interaction.options.getString('text')?.trim() || null;

  if (!text) {
    db.clearBankItemNote(item, mule);
    return interaction.reply(`✅ Cleared the note on **${item}** (_${mule}_).`);
  }

  db.setBankItemNote(item, mule, text, interaction.user.id);
  const inStock = db.getBankItemQuantity(item, mule) > 0;
  const warning = inStock ? '' : '\n⚠️ That item has no stock on that mule right now — the note will show if it comes back.';
  return interaction.reply(`✅ Note set on **${item}** (_${mule}_): ${text}${warning}`);
}

async function handleUndo(interaction) {
  if (!isOfficer(interaction.member)) {
    return interaction.reply({ content: '❌ Only officers can undo bank transactions.', flags: 64 });
  }

  const id = interaction.options.getInteger('id');
  const tx = db.getBankTransaction(id);
  if (!tx) {
    return interaction.reply({ content: `❌ No bank transaction with id \`#${id}\`. Check \`/bank history\`.`, flags: 64 });
  }

  db.deleteBankTransaction(id);
  const icon = tx.type === 'deposit' ? '➕' : '➖';
  return interaction.reply(
    `✅ Removed transaction \`[#${tx.id}]\`: ${icon} ${tx.quantity}× **${tx.item_name}** — _${tx.mule}_ (${tx.type}).`
  );
}

// ── Exports ────────────────────────────────────────────────────────────────

module.exports = {
  data,
  execute,
  autocomplete,
  extraChannels: [process.env.BANK_CHANNEL_ID].filter(Boolean),
};
