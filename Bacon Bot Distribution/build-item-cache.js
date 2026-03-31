'use strict';

const quarmDb = require('./lib/quarm-db');
const fs = require('fs');
const path = require('path');

const DB_PATH = process.argv[2] || 'C:\\Apps\\quarm\\db';
const CONFIG_FILE = path.join(__dirname, 'config.json');

console.log('Building item cache...');
console.log(`SQL dump directory: ${DB_PATH}`);

// Init cache
quarmDb.initCache();

// Find dump file
const dumpFile = quarmDb.findDumpFile(DB_PATH);
if (!dumpFile) {
  console.error('No quarm_*.sql file found in', DB_PATH);
  process.exit(1);
}
console.log(`Found: ${dumpFile}`);

// Import zones
const zoneCount = quarmDb.importZones(dumpFile);
console.log(`Imported ${zoneCount} zones`);

// Import items for approved zones from config
let approvedZones = [];
try {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  approvedZones = cfg.approvedZones || [];
} catch {
  console.log('No config.json found, importing items for ALL zones');
  approvedZones = quarmDb.getAllZones().map(z => z.long_name);
}

if (approvedZones.length > 0) {
  const shortNames = approvedZones.map(z => quarmDb.getZoneShortName(z)).filter(Boolean);
  console.log(`Importing items for ${shortNames.length} zones...`);
  const itemCount = quarmDb.importItemsForZones(dumpFile, shortNames);
  console.log(`Imported ${itemCount} unique items`);
} else {
  console.log('No approved zones configured');
}

console.log('Done! quarm-cache.db is ready for distribution.');
