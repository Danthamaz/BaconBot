'use strict';

/**
 * Interactive seed script: reads #list-your-characters, proposes character names,
 * prompts for confirmation, and learns from corrections.
 *
 * Run:          node seed-chars.js
 * Dry run:      node seed-chars.js --dry-run
 * Reset learnings: node seed-chars.js --reset-learnings
 *
 * Learnings are saved to seed-learnings.json and applied on every future run.
 */

require('dotenv').config();

const readline = require('readline');
const fs       = require('fs');
const path     = require('path');
const { REST, Routes } = require('discord.js');
const { linkCharacter } = require('./lib/db');

const CHANNEL_ID     = '1429088770702966916';
const LEARNINGS_FILE = path.join(__dirname, 'seed-learnings.json');
const DRY_RUN        = process.argv.includes('--dry-run');

// ── Stop words ─────────────────────────────────────────────────────────────

const BASE_STOP_WORDS = new Set([
  'my', 'and', 'or', 'the', 'is', 'are', 'was', 'main', 'alt', 'alts',
  'chars', 'char', 'characters', 'character', 'name', 'names', 'here', 'have',
  'has', 'not', 'but', 'for', 'with', 'list', 'their', 'also', 'plus',
  'toon', 'toons', 'new', 'old', 'yes', 'no', 'hey', 'hi', 'hello',
  'all', 'any', 'some', 'now', 'then', 'just', 'please', 'thanks',
  'use', 'used', 'can', 'will', 'that', 'this', 'from', 'play', 'box',
  'currently', 'account', 'accounts', 'discord', 'server', 'guild',
  'pet', 'one', 'two', 'three', 'four', 'five', 'six', 'level',
  'lvl', 'class', 'druid', 'mage', 'monk', 'cleric', 'warrior', 'shaman',
  'necro', 'wiz', 'bard', 'rogue', 'ranger', 'paladin', 'shadow', 'knight',
  'enchanter', 'beastlord', 'berserker', 'gnome', 'dwarf', 'elf', 'ogre',
  'troll', 'human', 'iksar', 'vah', 'shir', 'wood', 'dark', 'high',
  'halfling', 'barbarian', 'erudite', 'omg', 'wtf', 'lol', 'lmao', 'rofl', 'brd', 'shm', 'wiz', 'nec', 'clr', 'mnk', 'dru', 'rog', 'rng', 'pal', 'sk', 'pal', 'ench'
]);

// ── Learnings persistence ──────────────────────────────────────────────────

function loadLearnings() {
  if (process.argv.includes('--reset-learnings')) {
    if (fs.existsSync(LEARNINGS_FILE)) fs.unlinkSync(LEARNINGS_FILE);
    console.log('Learnings reset.\n');
  }
  try {
    const raw = JSON.parse(fs.readFileSync(LEARNINGS_FILE, 'utf8'));
    return new Set((raw.stopWords || []).map(w => w.toLowerCase()));
  } catch {
    return new Set();
  }
}

function saveLearnings(learnedStopWords) {
  fs.writeFileSync(LEARNINGS_FILE, JSON.stringify(
    { stopWords: [...learnedStopWords].sort() },
    null, 2
  ));
}

// ── Name extraction ────────────────────────────────────────────────────────

function extractNames(content, stopWords) {
  const tokens = content.split(/[\s,;/|():\[\]{}"'!?.+\-_*#@&]+/);
  const seen   = new Set();
  const names  = [];

  for (const raw of tokens) {
    const tok = raw.trim();
    if (!/^[A-Za-z]{3,15}$/.test(tok)) continue;
    const lower = tok.toLowerCase();
    if (BASE_STOP_WORDS.has(lower)) continue;
    if (stopWords.has(lower))       continue;
    if (seen.has(lower))            continue;
    seen.add(lower);
    // Title-case to match EQ in-game format
    names.push(tok.charAt(0).toUpperCase() + tok.slice(1).toLowerCase());
  }

  return names;
}

// ── Discord fetch ──────────────────────────────────────────────────────────

async function fetchAllMessages(rest) {
  const messages = [];
  let before     = undefined;

  while (true) {
    const params = new URLSearchParams({ limit: '100' });
    if (before) params.set('before', before);

    const batch = await rest.get(
      Routes.channelMessages(CHANNEL_ID) + '?' + params.toString()
    );

    if (!Array.isArray(batch) || batch.length === 0) break;
    messages.push(...batch);
    before = batch.at(-1).id;
    process.stdout.write(`  Fetched ${messages.length} messages…\r`);
    if (batch.length < 100) break;
  }

  process.stdout.write('\n');
  // Chronological order (oldest first → process in posting order)
  return messages.reverse();
}

// ── Interactive prompt ─────────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

const CYAN   = s => `\x1b[36m${s}\x1b[0m`;
const YELLOW = s => `\x1b[33m${s}\x1b[0m`;
const GREEN  = s => `\x1b[32m${s}\x1b[0m`;
const RED    = s => `\x1b[31m${s}\x1b[0m`;
const DIM    = s => `\x1b[2m${s}\x1b[0m`;

async function confirmNames(rl, msg, proposed, learnedStopWords) {
  const author  = msg.author.username;
  const content = msg.content.replace(/\n/g, ' ').slice(0, 120);

  console.log('\n' + '─'.repeat(60));
  console.log(`${CYAN('@' + author)} (${DIM(msg.author.id)})`);
  console.log(`${DIM('Message:')} "${content}"`);
  console.log(`${YELLOW('Proposed:')} ${proposed.map(n => YELLOW(n)).join(', ')}`);
  console.log();
  console.log(`  ${GREEN('[y]')} Accept all    ${GREEN('[n]')} None correct`);
  console.log(`  ${GREEN('[e]')} Edit names    ${GREEN('[s]')} Skip (decide later)`);

  while (true) {
    const ans = (await prompt(rl, '  Choice: ')).trim().toLowerCase();

    if (ans === 'y' || ans === '') {
      return { accepted: proposed, rejected: [] };
    }

    if (ans === 'n') {
      // All proposed names were wrong → learn them all
      const rejected = proposed.map(n => n.toLowerCase());
      for (const w of rejected) learnedStopWords.add(w);
      saveLearnings(learnedStopWords);
      console.log(RED(`  Learned to ignore: ${rejected.join(', ')}`));
      return { accepted: [], rejected };
    }

    if (ans === 'e') {
      console.log('  Enter the correct character name(s), comma-separated.');
      console.log(`  ${DIM('(Leave blank to accept none)')}`);
      const raw      = await prompt(rl, '  Names: ');
      const accepted = raw.split(/[\s,;]+/)
        .map(t => t.trim())
        .filter(t => /^[A-Za-z]{2,15}$/.test(t))
        .map(t => t.charAt(0).toUpperCase() + t.slice(1).toLowerCase());

      // Any proposed name NOT in accepted list → learn it
      const acceptedLower = new Set(accepted.map(n => n.toLowerCase()));
      const rejected = proposed
        .map(n => n.toLowerCase())
        .filter(n => !acceptedLower.has(n));

      for (const w of rejected) learnedStopWords.add(w);
      if (rejected.length > 0) {
        saveLearnings(learnedStopWords);
        console.log(RED(`  Learned to ignore: ${rejected.join(', ')}`));
      }
      if (accepted.length > 0) {
        console.log(GREEN(`  Accepted: ${accepted.join(', ')}`));
      }
      return { accepted, rejected };
    }

    if (ans === 's') {
      console.log(DIM('  Skipped.'));
      return null; // caller will queue for later
    }

    console.log('  Please enter y, n, e, or s.');
  }
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  if (!process.env.DISCORD_TOKEN) {
    console.error('DISCORD_TOKEN not set in .env');
    process.exit(1);
  }

  const learnedStopWords = loadLearnings();
  if (learnedStopWords.size > 0) {
    console.log(`Loaded ${learnedStopWords.size} learned exclusion(s): ${[...learnedStopWords].join(', ')}\n`);
  }
  if (DRY_RUN) console.log('[DRY RUN] No changes will be written.\n');

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  console.log(`Fetching messages from channel ${CHANNEL_ID}…`);
  const allMessages = await fetchAllMessages(rest);
  console.log(`Fetched ${allMessages.length} messages.\n`);

  // Pre-filter: skip bots, non-default, empty
  const candidates = allMessages.filter(m =>
    !m.author?.bot &&
    m.type === 0 &&
    m.content?.trim()
  );
  console.log(`${candidates.length} user message(s) to review.\n`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const linked   = []; // { author, authorId, names }
  const skipped  = [];
  let   msgIndex = 0;

  for (const msg of candidates) {
    msgIndex++;
    process.stdout.write(`\n[${msgIndex}/${candidates.length}] `);

    // Re-extract names with the latest learned exclusions applied
    const proposed = extractNames(msg.content, learnedStopWords);

    if (proposed.length === 0) {
      console.log(DIM(`@${msg.author.username}: no candidate names found — auto-skipping.`));
      continue;
    }

    const result = await confirmNames(rl, msg, proposed, learnedStopWords);

    if (result === null) {
      skipped.push(msg);
      continue;
    }

    if (result.accepted.length > 0) {
      if (!DRY_RUN) {
        for (const name of result.accepted) {
          linkCharacter(name, msg.author.id, msg.author.username);
        }
      }
      linked.push({ author: msg.author.username, authorId: msg.author.id, names: result.accepted });
    }
  }

  // ── Handle skipped messages ──────────────────────────────────────────────
  if (skipped.length > 0) {
    console.log('\n' + '═'.repeat(60));
    console.log(`${skipped.length} message(s) were skipped. Review them now? (y/n)`);
    const ans = (await prompt(rl, '  Choice: ')).trim().toLowerCase();

    if (ans === 'y') {
      for (const msg of skipped) {
        const proposed = extractNames(msg.content, learnedStopWords);

        if (proposed.length === 0) {
          console.log(DIM(`@${msg.author.username}: no candidates after learned exclusions — skipping.`));
          continue;
        }

        const result = await confirmNames(rl, msg, proposed, learnedStopWords);
        if (result?.accepted.length > 0) {
          if (!DRY_RUN) {
            for (const name of result.accepted) {
              linkCharacter(name, msg.author.id, msg.author.username);
            }
          }
          linked.push({ author: msg.author.username, authorId: msg.author.id, names: result.accepted });
        }
      }
    }
  }

  rl.close();

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(60));
  console.log(GREEN('Done!\n'));

  const totalChars = linked.reduce((n, e) => n + e.names.length, 0);
  console.log(`${totalChars} character(s) linked across ${linked.length} user(s):`);
  for (const { author, names } of linked) {
    console.log(`  @${author}: ${names.join(', ')}`);
  }

  console.log(`\nLearned exclusions total: ${learnedStopWords.size} word(s)`);
  if (DRY_RUN) console.log(YELLOW('\n[DRY RUN] No data was written to the DB.'));
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
