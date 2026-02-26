'use strict';

/**
 * One-time script: seeds the Sleeper's Tomb key holder list.
 * Run: node seed-keys.js
 */

require('dotenv').config();
const { addKeyHolder, getKeyHolders } = require('./lib/db');

const KEY_HOLDERS = [
  { character: 'Rhondaz',     discordTag: 'Twainz'                          },
  { character: 'Ogielocks',   discordTag: 'Ogielocks'                       },
  { character: 'Corazz',      discordTag: 'Corazz'                          },
  { character: 'Fishnchips',  discordTag: 'Fishnchips'                      },
  { character: 'Yogix',       discordTag: 'Yogi'                            },
  { character: 'Homunkulus',  discordTag: 'Homunkulus'                      },
  { character: 'Burnttoastt', discordTag: 'Ftyo/Mistythickett/Burnttoastt'  },
  { character: 'Blkbullet',   discordTag: 'Blkbullet'                       },
  { character: 'Kavija',      discordTag: 'Kav/Krav'                        },
  { character: 'Vespera',     discordTag: 'Effie/Shen'                      },
  { character: 'Mythosaur',   discordTag: 'Mythosaur'                       },
  { character: 'Badcop',      discordTag: 'Badcop/Belthazaar/Burntbiscuits' },
  { character: 'Majesti',     discordTag: 'Fkin/Majesti'                    },
];

console.log("Seeding Sleeper's Tomb key holders…\n");

for (const { character, discordTag } of KEY_HOLDERS) {
  addKeyHolder(character, discordTag);
  console.log(`  ✓ ${character.padEnd(14)} (${discordTag})`);
}

console.log(`\nDone. ${KEY_HOLDERS.length} key holder(s) seeded.`);
console.log('\nCurrent DB state:');
for (const h of getKeyHolders()) {
  const linked = h.discord_id ? ` → linked to <${h.discord_id}>` : ' (not yet linked)';
  console.log(`  ${h.character_name.padEnd(14)} @${h.discord_tag}${linked}`);
}
