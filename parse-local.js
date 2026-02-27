'use strict';

/**
 * Local parse script — run on the guild leader's PC to submit large log files.
 *
 * Usage:
 *   node parse-local.js --file "C:\path\to\eqlog.txt" ^
 *                       --name "VP Thursday 2/26" ^
 *                       --zone "Veeshan's Peak" ^
 *                       --date "2026-02-26" ^
 *                       --start "20:00" ^
 *                       --end "23:00" ^
 *                       --character "Lyri"
 *
 *   Merge into existing raid:
 *   node parse-local.js ... --raid-id 12
 *
 * Config (set once in .env or pass as args):
 *   SERVER_URL=http://129.146.142.5:3001
 *   API_KEY=your_secret_key
 */

require('dotenv').config();

const https   = require('https');
const http    = require('http');
const { parseLog } = require('./lib/parser');

// ── Arg parsing ────────────────────────────────────────────────────────────

const args = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i].startsWith('--')) {
    const key = argv[i].slice(2);
    args[key] = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true;
    if (!argv[i + 1]?.startsWith('--')) i++;
  }
}

const file      = args['file'];
const raidName  = args['name'];
const zoneInput = args['zone'];
const dateStr   = args['date'];
const startStr  = args['start'];
const endStr    = args['end'];
const character = args['character'];
const raidId    = args['raid-id'] ? parseInt(args['raid-id'], 10) : null;
const serverUrl = args['server'] || process.env.SERVER_URL || 'http://129.146.142.5:3001';
const apiKey    = args['key']    || process.env.API_KEY;

// ── Validation ─────────────────────────────────────────────────────────────

const missing = [];
if (!file)      missing.push('--file');
if (!raidName && !raidId)  missing.push('--name');
if (!zoneInput) missing.push('--zone');
if (!dateStr)   missing.push('--date');
if (!startStr)  missing.push('--start');
if (!endStr)    missing.push('--end');
if (!character) missing.push('--character');
if (!apiKey)    missing.push('--key (or API_KEY in .env)');

if (missing.length > 0) {
  console.error(`Missing required arguments: ${missing.join(', ')}`);
  console.error('\nExample:');
  console.error('  node parse-local.js --file "C:\\Logs\\eqlog.txt" --name "VP Thursday" --zone "Veeshan\'s Peak" --date "2026-02-26" --start "20:00" --end "23:00" --character "Lyri"');
  process.exit(1);
}

// ── Date helpers ───────────────────────────────────────────────────────────

function parseDate(str) {
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) return new Date(+m[3], +m[1] - 1, +m[2]);
  return null;
}

function applyTime(date, timeStr) {
  const m = timeStr.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
  if (!m) return false;
  date.setHours(+m[1], +m[2], +(m[3] || 0), 0);
  return true;
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  const startDate = parseDate(dateStr);
  const endDate   = parseDate(dateStr);

  if (!startDate) { console.error('Invalid date format. Use YYYY-MM-DD or MM/DD/YYYY.'); process.exit(1); }
  if (!applyTime(startDate, startStr)) { console.error('Invalid start time. Use HH:MM.'); process.exit(1); }
  if (!applyTime(endDate,   endStr))   { console.error('Invalid end time. Use HH:MM.');   process.exit(1); }
  if (endDate <= startDate) endDate.setDate(endDate.getDate() + 1); // crosses midnight

  const zones = zoneInput.split(',').map(z => z.trim()).filter(Boolean);

  console.log('\n══════════════════════════════════════════');
  console.log('  BaconBot — Local Log Parser');
  console.log('══════════════════════════════════════════');
  console.log(`  File     : ${file}`);
  console.log(`  Raid     : ${raidName || `(merge into #${raidId})`}`);
  console.log(`  Zone(s)  : ${zones.join(', ')}`);
  console.log(`  Window   : ${startDate.toLocaleString()} → ${endDate.toLocaleString()}`);
  console.log(`  Character: ${character}`);
  console.log(`  Server   : ${serverUrl}`);
  if (raidId) console.log(`  Merge ID : ${raidId}`);
  console.log('══════════════════════════════════════════\n');

  console.log('Parsing log file...');
  const startMs = Date.now();
  let lastReport = Date.now();

  const result = await parseLog({
    filePath:      file,
    startTime:     startDate,
    endTime:       endDate,
    zones,
    characterName: character,
    onProgress: (lines) => {
      const now = Date.now();
      if (now - lastReport > 2000) {
        lastReport = now;
        process.stdout.write(`  ${(lines / 1000).toFixed(0)}k lines scanned...\r`);
      }
    },
  });

  const elapsed = ((Date.now() - startMs) / 1000).toFixed(1);
  process.stdout.write('\n');
  console.log(`\nParsed ${result.lineCount.toLocaleString()} lines in ${elapsed}s`);
  console.log(`  Attendance : ${result.attendance.length} players`);
  console.log(`  Loot       : ${result.loot.length} events`);

  if (result.attendance.length === 0 && result.loot.length === 0) {
    console.error('\n⚠️  No data found in that time range / zone. Check your date, time, and zone name.');
    process.exit(1);
  }

  console.log('\nSubmitting to server...');

  let response;
  if (raidId) {
    response = await post(`${serverUrl}/raid/merge?id=${raidId}`, {
      attendance: result.attendance,
      loot:       result.loot,
    }, apiKey);
  } else {
    response = await post(`${serverUrl}/raid`, {
      raid: {
        name:          raidName,
        zone:          zones.join(', '),
        startTime:     startDate.toISOString(),
        endTime:       endDate.toISOString(),
        characterName: character,
        submittedBy:   'local-script',
      },
      attendance: result.attendance,
      loot:       result.loot,
    }, apiKey);
  }

  if (response.status === 200) {
    const id = response.body.raidId;
    console.log(`\n✅ Success! Raid ID: ${id}`);
    if (response.body.newLoot !== undefined) {
      console.log(`   ${response.body.newLoot} new loot rows merged.`);
    }
    console.log(`\n   Use /raids info id:${id} in Discord to verify.`);
  } else {
    console.error(`\n❌ Server returned ${response.status}:`, response.body);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal error:', err.message);
  process.exit(1);
});
