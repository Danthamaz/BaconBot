# Raid Group Organizer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Parse a RaidTick file and generate optimal group assignments with ready-to-paste `/rm` commands.

**Architecture:** Purely client-side feature in the web app. New tab with file upload, JS group assignment algorithm, visual preview, and copy-to-clipboard command output. No server or bot API needed.

**Tech Stack:** Vanilla JS, HTML, CSS (matches existing web app patterns)

---

### Task 1: Add Raid Groups tab and file upload

**Files:**
- Modify: `Bacon Bot Distribution/public/index.html`
- Modify: `Bacon Bot Distribution/public/app.js`
- Modify: `Bacon Bot Distribution/public/style.css`

- [ ] **Step 1: Add the tab button in the nav**

In `index.html`, find the nav buttons and add Raid Groups between Live Mode and Parse:

```html
<button class="tab active" data-view="live">Live Mode</button>
<button class="tab" data-view="raidgroups">Raid Groups</button>
<button class="tab" data-view="parse">Parse</button>
<button class="tab" data-view="settings">Settings</button>
```

- [ ] **Step 2: Add the Raid Groups view section**

In `index.html`, add a new section between the Live Mode and Parse sections:

```html
    <!-- ═══ Raid Groups View ═══ -->
    <section id="view-raidgroups" class="view hidden">
      <div class="controls">
        <label class="btn-secondary file-upload-label">
          Upload RaidTick
          <input type="file" id="raidtick-file" accept=".txt" style="display:none">
        </label>
        <button id="btn-generate-groups" class="btn-primary" disabled>Generate Groups</button>
        <button id="btn-copy-commands" class="btn-secondary hidden">Copy Commands</button>
      </div>

      <div id="raidtick-roster" class="hidden">
        <div class="roster-summary" id="roster-summary"></div>
      </div>

      <div id="raid-groups-output" class="hidden">
        <div id="raid-groups-preview"></div>
        <div class="commands-block">
          <h3>Commands</h3>
          <pre id="raid-commands"></pre>
        </div>
      </div>
    </section>
```

- [ ] **Step 3: Add base CSS for the raid groups view**

In `style.css`, add:

```css
/* ── Raid Groups ─────────────────────────────────────────────── */
.file-upload-label {
  cursor: pointer;
  display: inline-block;
}

.roster-summary {
  margin-bottom: 16px;
  font-size: 13px;
  color: var(--text-dim);
}

.roster-summary strong {
  color: var(--text);
}

#raid-groups-preview {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(250px, 1fr));
  gap: 12px;
  margin-bottom: 20px;
}

.group-card {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 12px;
}

.group-card h4 {
  font-size: 13px;
  color: var(--accent);
  margin-bottom: 8px;
}

.group-card .group-member {
  font-size: 12px;
  font-family: monospace;
  padding: 2px 0;
  display: flex;
  justify-content: space-between;
}

.group-card .group-member .member-class {
  color: var(--text-dim);
  font-size: 11px;
}

.commands-block {
  background: var(--bg-card);
  border: 1px solid var(--border);
  border-radius: 6px;
  padding: 16px;
}

.commands-block h3 {
  font-size: 13px;
  color: var(--text-dim);
  margin-bottom: 8px;
}

.commands-block pre {
  font-family: monospace;
  font-size: 12px;
  color: var(--text);
  white-space: pre;
  max-height: 300px;
  overflow-y: auto;
  user-select: all;
}
```

- [ ] **Step 4: Wire up the file upload and button handlers in app.js**

Add a `setupRaidGroups()` function and call it from the DOMContentLoaded handler:

```javascript
function setupRaidGroups() {
  $('raidtick-file').addEventListener('change', handleRaidTickUpload);
  $('btn-generate-groups').addEventListener('click', generateRaidGroups);
  $('btn-copy-commands').addEventListener('click', copyRaidCommands);
}
```

Add `setupRaidGroups();` in the DOMContentLoaded handler after `setupLive()`.

Add the file upload handler:

```javascript
let raidRoster = [];

function handleRaidTickUpload(e) {
  const file = e.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(ev) {
    const lines = ev.target.result.split(/\r?\n/).filter(l => l.trim());
    raidRoster = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length < 3) continue;
      raidRoster.push({ name: parts[0], level: parseInt(parts[1], 10) || 0, class: parts[2] });
    }
    if (raidRoster.length === 0) { alert('No players found in file.'); return; }
    renderRosterSummary();
    $('btn-generate-groups').disabled = false;
    $('raidtick-roster').classList.remove('hidden');
    $('raid-groups-output').classList.add('hidden');
  };
  reader.readAsText(file);
}
```

- [ ] **Step 5: Add roster summary renderer**

```javascript
function renderRosterSummary() {
  const classCounts = {};
  for (const p of raidRoster) {
    classCounts[p.class] = (classCounts[p.class] || 0) + 1;
  }
  const sorted = Object.entries(classCounts).sort((a, b) => b[1] - a[1]);
  const parts = sorted.map(([cls, count]) => `<strong>${count}</strong> ${cls}`);
  $('roster-summary').innerHTML = `<strong>${raidRoster.length}</strong> players: ${parts.join(', ')}`;
}
```

- [ ] **Step 6: Commit**

```bash
git add "Bacon Bot Distribution/public/index.html" "Bacon Bot Distribution/public/app.js" "Bacon Bot Distribution/public/style.css"
git commit -m "feat: add Raid Groups tab with file upload"
```

---

### Task 2: Group assignment algorithm

**Files:**
- Modify: `Bacon Bot Distribution/public/app.js`

- [ ] **Step 1: Define class categories**

```javascript
const CLASS_CATEGORIES = {
  'Warrior':      'tank',
  'Paladin':      'tank',
  'Shadow Knight': 'tank',
  'Monk':         'melee',
  'Rogue':        'melee',
  'Ranger':       'melee',
  'Berserker':    'melee',
  'Beastlord':    'melee',
  'Wizard':       'caster',
  'Magician':     'caster',
  'Necromancer':  'caster',
  'Enchanter':    'caster',
  'Cleric':       'healer',
  'Druid':        'healer',
  'Shaman':       'healer',
  'Bard':         'bard',
};
```

- [ ] **Step 2: Implement the group assignment algorithm**

```javascript
function assignRaidGroups(roster) {
  const MAX_GROUP_SIZE = 6;
  const groups = []; // each group is { label: string, members: [] }

  // Categorize players
  const tanks = roster.filter(p => CLASS_CATEGORIES[p.class] === 'tank');
  const bards = roster.filter(p => CLASS_CATEGORIES[p.class] === 'bard');
  const shamans = roster.filter(p => p.class === 'Shaman');
  const healers = roster.filter(p => CLASS_CATEGORIES[p.class] === 'healer' && p.class !== 'Shaman');
  const melee = roster.filter(p => CLASS_CATEGORIES[p.class] === 'melee');
  const casters = roster.filter(p => CLASS_CATEGORIES[p.class] === 'caster');
  const allHealers = [...shamans, ...healers]; // shaman first for tank group priority

  const assigned = new Set();

  function assign(group, player) {
    if (assigned.has(player.name)) return false;
    if (group.members.length >= MAX_GROUP_SIZE) return false;
    group.members.push(player);
    assigned.add(player.name);
    return true;
  }

  function newGroup(label) {
    const g = { label, members: [] };
    groups.push(g);
    return g;
  }

  // --- Rule 1: Tank group (Group 1) ---
  const tankGroup = newGroup('Tank');
  for (const t of tanks) assign(tankGroup, t);
  // Add a shaman to tank group
  for (const s of shamans) { if (assign(tankGroup, s)) break; }
  // Add a bard to tank group
  for (const b of bards) { if (assign(tankGroup, b)) break; }
  // Fill remaining tank group slots with healers
  for (const h of allHealers) {
    if (tankGroup.members.length >= MAX_GROUP_SIZE) break;
    assign(tankGroup, h);
  }

  // --- Rule 2-5: Build melee and caster groups ---
  // Group same classes together
  const meleeByClass = {};
  for (const p of melee) {
    if (assigned.has(p.name)) continue;
    if (!meleeByClass[p.class]) meleeByClass[p.class] = [];
    meleeByClass[p.class].push(p);
  }

  const casterByClass = {};
  for (const p of casters) {
    if (assigned.has(p.name)) continue;
    if (!casterByClass[p.class]) casterByClass[p.class] = [];
    casterByClass[p.class].push(p);
  }

  // Build melee groups - stack classes, merge small classes together
  const meleeClasses = Object.values(meleeByClass).sort((a, b) => b.length - a.length);
  const meleeGroups = buildClassGroups(meleeClasses, 'Melee', MAX_GROUP_SIZE);

  // Build caster groups
  const casterClasses = Object.values(casterByClass).sort((a, b) => b.length - a.length);
  const casterGroups = buildClassGroups(casterClasses, 'Caster', MAX_GROUP_SIZE);

  // Add groups to the list
  for (const g of meleeGroups) groups.push(g);
  for (const g of casterGroups) groups.push(g);

  // Mark all grouped players as assigned
  for (const g of groups) {
    for (const m of g.members) assigned.add(m.name);
  }

  // --- Rule 2: Assign bards (one per group, melee groups first) ---
  const unassignedBards = bards.filter(b => !assigned.has(b.name));
  const meleeGroupsList = groups.filter(g => g.label.startsWith('Melee'));
  const casterGroupsList = groups.filter(g => g.label.startsWith('Caster'));
  const bardTargets = [...meleeGroupsList, ...casterGroupsList, tankGroup];

  for (const b of unassignedBards) {
    let placed = false;
    for (const g of bardTargets) {
      if (g.members.length < MAX_GROUP_SIZE && !g.members.some(m => CLASS_CATEGORIES[m.class] === 'bard')) {
        assign(g, b);
        placed = true;
        break;
      }
    }
    if (!placed) {
      // Overflow bard - add to any group with space
      for (const g of groups) { if (assign(g, b)) break; }
    }
  }

  // --- Rule 6: Distribute remaining healers ---
  const unassignedHealers = [...shamans, ...healers].filter(h => !assigned.has(h.name));
  // Spread across groups that don't have a healer
  const groupsWithoutHealer = groups.filter(g =>
    g !== tankGroup && !g.members.some(m => CLASS_CATEGORIES[m.class] === 'healer')
  );
  for (const h of unassignedHealers) {
    let placed = false;
    for (const g of groupsWithoutHealer) {
      if (g.members.length < MAX_GROUP_SIZE) {
        assign(g, h);
        placed = true;
        break;
      }
    }
    if (!placed) {
      for (const g of groups) { if (assign(g, h)) break; }
    }
  }

  // Any remaining unassigned players
  const remaining = roster.filter(p => !assigned.has(p.name));
  for (const p of remaining) {
    let placed = false;
    for (const g of groups) { if (assign(g, p)) { placed = true; break; } }
    if (!placed) {
      const g = newGroup(`Group ${groups.length + 1}`);
      assign(g, p);
    }
  }

  // Number the groups
  groups.forEach((g, i) => { g.number = i + 1; });

  return groups;
}

function buildClassGroups(classBuckets, labelPrefix, maxSize) {
  const groups = [];
  let current = null;

  for (const bucket of classBuckets) {
    for (const player of bucket) {
      if (!current || current.members.length >= maxSize) {
        current = { label: `${labelPrefix} ${groups.length + 1}`, members: [] };
        groups.push(current);
      }
      current.members.push(player);
    }
  }

  return groups;
}
```

- [ ] **Step 3: Commit**

```bash
git add "Bacon Bot Distribution/public/app.js"
git commit -m "feat: raid group assignment algorithm"
```

---

### Task 3: Visual preview and command output

**Files:**
- Modify: `Bacon Bot Distribution/public/app.js`

- [ ] **Step 1: Implement generateRaidGroups()**

```javascript
let raidGroupsResult = [];

function generateRaidGroups() {
  if (raidRoster.length === 0) return;
  raidGroupsResult = assignRaidGroups(raidRoster);

  // Render preview cards
  $('raid-groups-preview').innerHTML = raidGroupsResult.map(g => {
    const members = g.members.map(m =>
      `<div class="group-member"><span>${m.name}</span><span class="member-class">${m.level} ${m.class}</span></div>`
    ).join('');
    return `<div class="group-card"><h4>Group ${g.number}: ${g.label} (${g.members.length})</h4>${members}</div>`;
  }).join('');

  // Render commands
  const commands = raidGroupsResult.flatMap(g =>
    g.members.map(m => `/rm ${m.name} ${g.number}`)
  ).join('\n');
  $('raid-commands').textContent = commands;

  $('raid-groups-output').classList.remove('hidden');
  $('btn-copy-commands').classList.remove('hidden');
}
```

- [ ] **Step 2: Implement copyRaidCommands()**

```javascript
function copyRaidCommands() {
  const text = $('raid-commands').textContent;
  navigator.clipboard.writeText(text).then(() => {
    $('btn-copy-commands').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-commands').textContent = 'Copy Commands'; }, 2000);
  }).catch(() => {
    // Fallback for non-HTTPS
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
    $('btn-copy-commands').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-commands').textContent = 'Copy Commands'; }, 2000);
  });
}
```

- [ ] **Step 3: Commit**

```bash
git add "Bacon Bot Distribution/public/app.js"
git commit -m "feat: raid groups preview and copy commands"
```

---

### Task 4: Deploy

- [ ] **Step 1: Commit any remaining changes, push, and deploy**

```bash
git push origin master
ssh -i ~/.ssh/id_ed25519 opc@129.146.138.160 "bash ~/bacon-bot/deploy/update.sh"
```
