'use strict';

/**
 * Local auto-parse script — scans an entire EQ log, detects raid sessions
 * automatically (Wed/Fri/Sat/Sun 1–5pm UTC, approved zones), and submits
 * each one to the bot server after confirmation.
 *
 * Usage:
 *   node parse-local.js --file "C:\path\to\eqlog.txt" --timezone "America/Phoenix" --character "Lyri"
 *
 * Options:
 *   --file        Path to the EQ log file (required)
 *   --timezone    IANA timezone of the log, e.g. America/Phoenix, America/Chicago (required)
 *   --character   Log owner's character name for self-loot attribution (recommended)
 *   --yes         Auto-confirm all sessions without prompting
 *   --dry-run     Parse and show results, do not submit anything
 *   --server      Override server URL (default: SERVER_URL in .env)
 *   --key         Override API key (default: API_KEY in .env)
 *
 * Common timezones:
 *   Arizona (no DST)  : America/Phoenix
 *   Central Time      : America/Chicago
 *   Eastern Time      : America/New_York
 *   Mountain Time     : America/Denver
 *   Pacific Time      : America/Los_Angeles
 */

require('dotenv').config();

const readline = require('readline');
const https    = require('https');
const http     = require('http');
const { autoParseLog, APPROVED_ZONES } = require('./lib/parser');

// ── Args ───────────────────────────────────────────────────────────────────

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
    args[key] = val;
    if (val !== true) i++;
  }
}

const file      = args['file'];
const timezone  = args['timezone'];
const character = args['character'] || null;
const autoYes   = args['yes']      === true;
const dryRun    = args['dry-run']  === true;
const serverUrl = args['server']   || process.env.SERVER_URL || 'http://129.146.142.5:3001';
const apiKey    = args['key']      || process.env.API_KEY;

// ── Validation ─────────────────────────────────────────────────────────────

const missing = [];
if (!file)     missing.push('--file');
if (!timezone) missing.push('--timezone');
if (!dryRun && !apiKey) missing.push('--key or API_KEY in .env');

if (missing.length) {
  console.error(`\nMissing: ${missing.join(', ')}\n`);
  console.error('Example:');
  console.error('  node parse-local.js --file "C:\\Logs\\eqlog.txt" --timezone "America/Phoenix" --character "Lyri"');
  process.exit(1);
}

// Validate timezone
try {
  Intl.DateTimeFormat(undefined, { timeZone: timezone });
} catch {
  console.error(`Invalid timezone: "${timezone}"`);
  console.error('Use an IANA timezone name, e.g. America/Phoenix, America/Chicago');
  process.exit(1);
}

// ── HTTP POST ──────────────────────────────────────────────────────────────

function post(url, body, key) {
  return new Promise((resolve, reject) => {
    const data   = JSON.stringify(body);
    const parsed = new URL(url);
    const opts   = {
      hostname: parsed.hostname,
      port:     parsed.port,
      path:     parsed.pathname + parsed.search,
      method:   'POST',
      headers:  {
        'Content-Type':   'application/json',
        'Content-Length': Buffer.byteLength(data),
        'x-api-key':      key,
      },
    };
    const client = url.startsWith('https') ? https : http;
    const req = client.request(opts, res => {
      let resp = '';
      res.on('data', c => { resp += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(resp) }); }
        catch { resolve({ status: res.statusCode, body: resp }); }
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

// ── Interactive prompt ─────────────────────────────────────────────────────

function prompt(rl, question) {
  return new Promise(resolve => rl.question(question, resolve));
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n══════════════════════════════════════════');
  console.log('  BaconBot — Auto Log Parser');
  console.log('══════════════════════════════════════════');
  console.log(`  File      : ${file}`);
  console.log(`  Timezone  : ${timezone}`);
  console.log(`  Character : ${character || '(not set — self-loot won\'t be attributed)'}`);
  console.log(`  Server    : ${dryRun ? '(dry run)' : serverUrl}`);
  console.log(`  Schedule  : Wed/Fri/Sat/Sun  13:00–17:00 UTC`);
  console.log('══════════════════════════════════════════\n');

  console.log('Scanning log file...');
  const startMs   = Date.now();
  let lastReport  = Date.now();

  const { sessions, lineCount } = await autoParseLog({
    filePath:      file,
    timezone,
    characterName: character,
    onProgress: lines => {
      const now = Date.now();
      if (now - lastReport > 2000) {
        lastReport = now;
        process.stdout.write(`  ${(lines / 1000000).toFixed(2)}M lines scanned...\r`);
      }
    },
  });

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  process.stdout.write('\n');
  console.log(`Scanned ${lineCount.toLocaleString()} lines in ${elapsed}s\n`);

  if (sessions.length === 0) {
    console.log('No raid sessions found.');
    console.log('Check that your log covers Wed/Fri/Sat/Sun during 1–5pm UTC and');
    console.log('includes /who output while in an approved zone.\n');
    console.log('Approved zones:');
    console.log('  ' + APPROVED_ZONES.join(', '));
    return;
  }

  console.log(`Found ${sessions.length} raid session(s):\n`);
  sessions.forEach((s, i) => {
    const startUTC = s.firstSeen.toISOString().slice(11, 16);
    const endUTC   = s.lastSeen.toISOString().slice(11, 16);
    console.log(`  [${i + 1}] ${s.date} ${s.dayName}`);
    console.log(`       Zones     : ${s.zones.join(', ') || 'unknown'}`);
    console.log(`       Attendance: ${s.attendance.length} players`);
    console.log(`       Loot      : ${s.loot.length} events`);
    console.log(`       UTC window: ${startUTC} – ${endUTC}`);
    console.log();
  });

  if (dryRun) {
    console.log('[Dry run] Nothing submitted.');
    return;
  }

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  let submitted = 0;
  let skipped   = 0;

  for (const [idx, session] of sessions.entries()) {
    const autoName    = `${session.date} ${session.dayName} - ${session.zones.slice(0, 2).join(', ')}`;
    const zoneStr     = session.zones.join(', ');
    const startUTC    = session.firstSeen.toISOString().slice(11, 16);
    const endUTC      = session.lastSeen.toISOString().slice(11, 16);

    console.log(`─── Session ${idx + 1}/${sessions.length}: ${session.date} ${session.dayName} ───`);
    console.log(`  Zones      : ${zoneStr}`);
    console.log(`  Attendance : ${session.attendance.length} players`);
    console.log(`  Loot       : ${session.loot.length} events`);
    console.log(`  UTC window : ${startUTC} – ${endUTC}`);

    let raidName = autoName;
    let submit   = autoYes;

    if (!autoYes) {
      const nameInput = (await prompt(rl, `  Raid name  [${autoName}]: `)).trim();
      if (nameInput) raidName = nameInput;

      const ans = (await prompt(rl, '  Submit? (y/n): ')).trim().toLowerCase();
      submit = (ans === 'y' || ans === 'yes');
    } else {
      console.log(`  Raid name  : ${raidName} (auto)`);
    }

    if (!submit) {
      console.log('  Skipped.\n');
      skipped++;
      continue;
    }

    try {
      const res = await post(`${serverUrl}/raid`, {
        raid: {
          name:          raidName,
          zone:          zoneStr,
          startTime:     session.firstSeen.toISOString(),
          endTime:       session.lastSeen.toISOString(),
          characterName: character || null,
          submittedBy:   'local-script',
        },
        attendance: session.attendance,
        loot:       session.loot,
      }, apiKey);

      if (res.status === 200) {
        console.log(`  ✓ Saved as Raid #${res.body.raidId}\n`);
        submitted++;
      } else {
        console.error(`  ✗ Server error ${res.status}:`, res.body, '\n');
      }
    } catch (err) {
      console.error(`  ✗ Request failed: ${err.message}\n`);
    }
  }

  rl.close();

  console.log('══════════════════════════════════════════');
  console.log(`  Done. ${submitted} submitted, ${skipped} skipped.`);
  console.log('══════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
