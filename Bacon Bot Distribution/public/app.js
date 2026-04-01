'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let config       = { character: '', timezone: 'America/Phoenix', eqFolder: '' };
let logFile      = null;
let sessions     = [];
let voiceMembers = null; // null = not fetched, [] = fetched but empty
let liveSource   = null;
let liveRunning  = false;
let voiceInterval = null;
let allZones     = [];
let searchTimeout = null;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupSettings();
  setupParse();
  setupLive();
  setupRaidGroups();
  setupItemFilters();

  // Heartbeat — keeps server alive while tab is open
  setInterval(() => { fetch('/api/heartbeat').catch(() => {}); }, 10000);
  await loadConfig();
});

// ── Tab navigation ───────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      document.querySelectorAll('.view').forEach(v => { v.classList.remove('active'); v.classList.add('hidden'); });
      tab.classList.add('active');
      const view = $('view-' + tab.dataset.view);
      view.classList.remove('hidden');
      view.classList.add('active');
    });
  });
}

// ── Settings ─────────────────────────────────────────────────────────────────
function setupSettings() {
  $('btn-save-config').addEventListener('click', saveSettings);
  $('btn-detect').addEventListener('click', detectLog);
}

async function loadConfig() {
  try {
    const res = await fetch('/api/config');
    config = await res.json();
    $('cfg-character').value = config.character || '';
    $('cfg-timezone').value  = config.timezone  || 'America/Phoenix';
    $('cfg-eqfolder').value  = config.eqFolder  || '';

    // Raid schedule
    const days = config.raidDays || [0, 3, 5, 6];
    document.querySelectorAll('#cfg-raid-days input').forEach(cb => {
      cb.checked = days.includes(parseInt(cb.value, 10));
    });
    $('cfg-raid-start').value = config.raidStartUTC ?? 13;
    $('cfg-raid-end').value   = config.raidEndUTC ?? 17;

    // Zone combo box
    await loadZoneList();
    setupZoneCombo();
    renderZoneTags();
    $('cfg-eqdbpath').value = config.eqDbPath || '';

    // Ignored items
    $('cfg-ignored-items').value = (config.ignoredItems || []).slice().sort((a, b) => a.localeCompare(b)).join('\n');

    updateStatusBar();

    // Auto-detect log file if config is set
    if (config.character && config.eqFolder) {
      await detectLog(true);
    }

    // If no config, show settings tab
    if (!config.character) {
      document.querySelector('[data-view="settings"]').click();
    }
  } catch {
    showSettingsStatus('Cannot connect to server', 'error');
  }
}

async function saveSettings() {
  config.character = $('cfg-character').value.trim();
  config.timezone  = $('cfg-timezone').value;
  config.eqFolder  = $('cfg-eqfolder').value.trim();

  // Raid schedule
  config.raidDays = [];
  document.querySelectorAll('#cfg-raid-days input:checked').forEach(cb => {
    config.raidDays.push(parseInt(cb.value, 10));
  });
  config.raidStartUTC = parseInt($('cfg-raid-start').value, 10) || 13;
  config.raidEndUTC   = parseInt($('cfg-raid-end').value, 10) || 17;

  // EQ Database Path
  config.eqDbPath = $('cfg-eqdbpath').value.trim();
  // config.approvedZones is already maintained by addZone/removeZone

  // Ignored items
  config.ignoredItems = $('cfg-ignored-items').value
    .split('\n')
    .map(i => i.trim())
    .filter(i => i.length > 0)
    .sort((a, b) => a.localeCompare(b));

  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    });
    showSettingsStatus('Settings saved', 'success');
    updateStatusBar();
    if (config.character && config.eqFolder) await detectLog(true);
  } catch {
    showSettingsStatus('Failed to save settings', 'error');
  }
}

async function detectLog(silent) {
  const character = $('cfg-character').value.trim() || config.character;
  const eqFolder  = $('cfg-eqfolder').value.trim() || config.eqFolder;
  if (!character || !eqFolder) {
    if (!silent) showSettingsStatus('Enter character name and EQ folder first', 'error');
    return;
  }

  try {
    const res  = await fetch(`/api/detect-log?character=${encodeURIComponent(character)}&eqFolder=${encodeURIComponent(eqFolder)}`);
    const data = await res.json();
    if (res.ok) {
      logFile = data.file;
      $('detected-log').classList.remove('hidden');
      $('detected-log-path').textContent = logFile;
      updateStatusBar();
      if (!silent) showSettingsStatus('Log file detected', 'success');
    } else {
      if (!silent) showSettingsStatus(data.error, 'error');
    }
  } catch {
    if (!silent) showSettingsStatus('Detection failed', 'error');
  }
}

function showSettingsStatus(msg, type) {
  const el = $('settings-status');
  el.textContent = msg;
  el.className = 'status-msg ' + type;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function updateStatusBar() {
  $('status-character').textContent = config.character || '--';
  $('status-log-file').textContent  = logFile || 'No log file';
  $('status-server').className      = 'status-dot green';
}

// ── Parse Mode ───────────────────────────────────────────────────────────────
function setupParse() {
  $('btn-scan').addEventListener('click', startParse);
  $('btn-upload').addEventListener('click', uploadSelected);
}

function startParse() {
  if (!logFile) {
    alert('No log file detected. Go to Settings and configure your character/EQ folder.');
    return;
  }

  sessions = [];
  $('parse-results').classList.add('hidden');
  $('parse-empty').classList.add('hidden');
  $('parse-progress').classList.remove('hidden');
  $('progress-fill').style.width = '0%';
  $('progress-text').textContent = '0%';
  $('btn-scan').disabled = true;
  $('session-list').innerHTML = '';

  const params = new URLSearchParams({
    file:      logFile,
    timezone:  config.timezone,
    character: config.character,
  });

  const source = new EventSource('/api/parse?' + params.toString());

  source.addEventListener('progress', e => {
    const d = JSON.parse(e.data);
    $('progress-fill').style.width = d.pct + '%';
    $('progress-text').textContent = `${d.pct}% - ${d.mb} MB scanned`;
  });

  source.addEventListener('complete', async e => {
    source.close();
    const d = JSON.parse(e.data);
    $('progress-fill').style.width = '100%';
    $('progress-text').textContent = `Done - ${d.lineCount.toLocaleString()} lines — checking voice...`;
    $('btn-scan').disabled = false;

    // Fetch current voice channel members
    await fetchVoiceMembers();

    const allSessions = d.sessions || [];
    sessions = filterByRange(allSessions, $('parse-range').value);

    // Tag attendance entries with voice status
    if (voiceMembers !== null) {
      for (const s of sessions) {
        tagAttendanceWithVoice(s);
      }
    }

    $('progress-text').textContent = `Done - ${d.lineCount.toLocaleString()} lines`;

    if (sessions.length === 0) {
      $('parse-empty').classList.remove('hidden');
      $('parse-progress').classList.add('hidden');
    } else {
      $('parse-results').classList.remove('hidden');
      $('results-summary').textContent = `${sessions.length} session(s) found`;
      renderSessions(sessions);
    }
  });

  source.addEventListener('error', e => {
    source.close();
    $('btn-scan').disabled = false;
    let msg = 'Parse error';
    try { msg = JSON.parse(e.data).message; } catch {}
    $('progress-text').textContent = msg;
  });

  source.onerror = () => {
    source.close();
    $('btn-scan').disabled = false;
    $('progress-text').textContent = 'Connection lost';
  };
}

function filterByRange(allSessions, range) {
  if (range === 'all') return allSessions;
  const now = new Date();
  let cutoff;
  switch (range) {
    case 'hour':  cutoff = new Date(now - 60 * 60 * 1000); break;
    case 'day':   cutoff = new Date(now - 24 * 60 * 60 * 1000); break;
    case 'week':  cutoff = new Date(now - 7 * 24 * 60 * 60 * 1000); break;
    case 'month': cutoff = new Date(now - 30 * 24 * 60 * 60 * 1000); break;
    default:      return allSessions;
  }
  return allSessions.filter(s => new Date(s.lastSeen) >= cutoff);
}

// ── Voice cross-reference ────────────────────────────────────────────────────
async function fetchVoiceMembers() {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);
    const res = await fetch('/api/voice-members', { signal: controller.signal });
    clearTimeout(timeout);
    if (res.ok) {
      const data = await res.json();
      voiceMembers = data.members || [];
    } else {
      voiceMembers = null;
    }
  } catch {
    voiceMembers = null;
  }
}

function tagAttendanceWithVoice(session) {
  if (!voiceMembers) return;
  // Build a set of lowercased character names + display names from voice
  const voiceNames = new Set();
  for (const vm of voiceMembers) {
    const chars = vm.characters || (vm.character ? [vm.character] : []);
    for (const ch of chars) voiceNames.add(ch.toLowerCase());
    voiceNames.add(vm.displayName.toLowerCase());
  }
  let inVoiceCount = 0;
  for (const a of session.attendance) {
    a._inVoice = voiceNames.has(a.name.toLowerCase());
    if (a._inVoice) inVoiceCount++;
  }
  session._voiceChecked = true;
  session._inVoiceCount = inVoiceCount;
}

function renderSessions(sessions) {
  const list = $('session-list');
  list.innerHTML = '';

  sessions.forEach((s, i) => {
    const card = document.createElement('div');
    card.className = 'session-card';
    card.dataset.index = i;

    const startUTC = s.firstSeen ? new Date(s.firstSeen).toISOString().slice(11, 16) : '??:??';
    const endUTC   = s.lastSeen  ? new Date(s.lastSeen).toISOString().slice(11, 16) : '??:??';
    const hasVoice = s._voiceChecked;
    const confirmedCount = hasVoice ? s._inVoiceCount : s.attendance.length;
    const voiceTag = hasVoice
      ? `<span class="voice-badge" title="Confirmed in both log and Discord voice">${s._inVoiceCount}/${s.attendance.length} in voice</span>`
      : '';

    card.innerHTML = `
      <div class="session-header" onclick="toggleSession(${i})">
        <input type="checkbox" checked onclick="event.stopPropagation()" data-session="${i}">
        <div class="session-info">
          <div class="session-date">${s.date} ${s.dayName}</div>
          <div class="session-meta">${s.zones.join(', ') || 'unknown'} | UTC ${startUTC} - ${endUTC}</div>
        </div>
        <div class="session-stats">
          <span><span class="session-stat-val">${s.attendance.length}</span> in log</span>
          ${voiceTag}
          <span><span class="session-stat-val">${s.loot.length}</span> loot</span>
        </div>
        <span class="session-status" id="status-${i}"></span>
        <span class="session-expand" id="expand-${i}">&#9660;</span>
      </div>
      <div class="session-body" id="body-${i}">
        <div class="section-label">Attendance (${hasVoice ? confirmedCount + ' confirmed / ' + s.attendance.length + ' in log' : s.attendance.length})</div>
        ${hasVoice ? '<div class="voice-legend"><span class="dot green"></span> In log + voice (will upload) <span class="dot red"></span> In log only (excluded)</div>' : ''}
        <table class="data-table">
          <thead><tr>${hasVoice ? '<th>Voice</th>' : ''}<th>Name</th><th>Level</th><th>Class</th><th>Guild</th></tr></thead>
          <tbody>
            ${s.attendance.map(a => {
              const voiceIcon = hasVoice ? `<td class="voice-col">${a._inVoice ? '<span class="dot green"></span>' : '<span class="dot red"></span>'}</td>` : '';
              const rowClass = hasVoice && !a._inVoice ? 'class="row-excluded"' : '';
              return `<tr ${rowClass}>${voiceIcon}<td>${a.name}</td><td>${a.level || '-'}</td><td>${a.class || '-'}</td><td>${a.guild || '-'}</td></tr>`;
            }).join('')}
          </tbody>
        </table>
        ${s.loot.length > 0 ? `
          <div class="section-label">Loot (${s.loot.length})</div>
          <table class="data-table">
            <thead><tr><th>Player</th><th>Item</th><th>Zone</th></tr></thead>
            <tbody>
              ${s.loot.map(l => `<tr><td>${l.playerName || '?'}</td><td>${l.itemName}</td><td>${l.zone || '-'}</td></tr>`).join('')}
            </tbody>
          </table>
        ` : ''}
      </div>
    `;
    list.appendChild(card);
  });
}

// global for inline onclick
window.toggleSession = function(i) {
  const body   = $('body-' + i);
  const expand = $('expand-' + i);
  body.classList.toggle('open');
  expand.classList.toggle('open');
};

async function uploadSelected() {
  const checks = document.querySelectorAll('[data-session]');
  const selected = [];
  checks.forEach(cb => { if (cb.checked) selected.push(parseInt(cb.dataset.session, 10)); });
  if (selected.length === 0) { alert('No sessions selected.'); return; }

  $('btn-upload').disabled = true;

  for (const idx of selected) {
    const statusEl = $('status-' + idx);
    statusEl.textContent = 'uploading...';
    statusEl.className = 'session-status uploading';

    try {
      // Filter attendance to only voice-confirmed players
      const session = { ...sessions[idx] };
      if (session._voiceChecked && voiceMembers !== null) {
        session.attendance = session.attendance.filter(a => a._inVoice);
      }
      // Strip internal tags before sending
      const cleanSession = { ...session };
      delete cleanSession._voiceChecked;
      delete cleanSession._inVoiceCount;
      cleanSession.attendance = cleanSession.attendance.map(a => {
        const { _inVoice, ...rest } = a;
        return rest;
      });

      const res = await fetch('/api/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session: cleanSession, character: config.character }),
      });
      const data = await res.json();
      if (res.ok) {
        if (data.action === 'merged') {
          statusEl.textContent = `Merged into Raid #${data.raidId}`;
        } else {
          statusEl.textContent = `Saved as Raid #${data.raidId}`;
        }
        statusEl.className = 'session-status saved';
        // Uncheck after successful upload
        const cb = document.querySelector(`[data-session="${idx}"]`);
        if (cb) cb.checked = false;
      } else {
        statusEl.textContent = data.error || 'Server error';
        statusEl.className = 'session-status error';
      }
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.className = 'session-status error';
    }
  }

  $('btn-upload').disabled = false;
}

// ── Live Mode ────────────────────────────────────────────────────────────────
function setupLive() {
  $('btn-live-toggle').addEventListener('click', toggleLive);
  $('btn-live-upload').addEventListener('click', uploadLiveSession);
  $('btn-end-raid').addEventListener('click', endRaid);
  $('btn-zone-override').addEventListener('click', overrideZone);
}

async function overrideZone() {
  const zone = $('live-zone-select').value;
  if (!zone) return;
  try {
    const res = await fetch('/api/live/zone', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ zone }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to set zone');
    }
  } catch {
    alert('Failed to set zone');
  }
}

function toggleLive() {
  if (liveRunning) {
    stopLive();
  } else {
    startLive();
  }
}

function startLive() {
  if (!logFile) {
    alert('No log file detected. Go to Settings and configure your character/EQ folder.');
    return;
  }

  const devMode = $('chk-dev-mode').checked;
  const params = new URLSearchParams({
    file:      logFile,
    timezone:  config.timezone,
    character: config.character,
  });
  if (devMode) params.set('devMode', '1');

  liveSource = new EventSource('/api/live?' + params.toString());
  liveRunning = true;

  $('btn-live-toggle').textContent = 'Stop Watching';
  $('chk-dev-mode').disabled = true;
  $('zone-inline').classList.remove('hidden');
  $('live-status').classList.remove('hidden');
  $('live-panels').classList.remove('hidden');
  $('btn-end-raid').classList.remove('hidden');
  $('btn-end-raid').textContent = 'End Raid';
  $('btn-end-raid').disabled = false;
  if (devMode) {
    $('btn-live-upload').classList.add('hidden');
    $('live-status-text').textContent = 'Watching (Dev Mode — not saving)...';
  } else {
    $('btn-live-upload').classList.remove('hidden');
    $('live-status-text').textContent = 'Watching...';
  }
  $('live-zone').textContent = '--';
  $('live-attendance').innerHTML = '';
  $('live-unlinked').innerHTML = '';
  $('live-loot').innerHTML = '';
  $('live-attend-count').textContent = '0';
  $('live-unlinked-count').textContent = '0';
  $('live-loot-count').textContent = '0';
  $('live-voice-count').textContent = '0';
  $('live-voice').innerHTML = '';

  // Populate zone override dropdown from approved zones
  const sel = $('live-zone-select');
  sel.innerHTML = '<option value="">-- Override Zone --</option>';
  for (const z of (config.approvedZones || []).slice().sort((a, b) => a.localeCompare(b))) {
    const opt = document.createElement('option');
    opt.value = z;
    opt.textContent = z;
    sel.appendChild(opt);
  }

  liveSource.addEventListener('started', async () => {
    $('live-status-text').textContent = 'Watching for changes...';
    refreshVoicePanel();
    voiceInterval = setInterval(refreshVoicePanel, 30000);

    // Check if session was restored
    try {
      const statusRes = await fetch('/api/session-status');
      if (statusRes.ok) {
        const status = await statusRes.json();
        if (status.available && status.playerCount > 0) {
          $('live-status-text').textContent = `Restored session (${status.playerCount} players, ${status.lootCount} loot)`;
        }
      }
    } catch {}
  });

  liveSource.addEventListener('zone', e => {
    const d = JSON.parse(e.data);
    $('live-zone').textContent = d.zone;
  });

  liveSource.addEventListener('attendance', async e => {
    const d = JSON.parse(e.data);
    console.log('[SSE attendance]', d.allPlayers?.length, 'players, zone:', d.zone);

    // Check if /who zone differs from current zone or no zone is set
    const currentZone = $('live-zone').textContent;
    console.log('[zone check] event zone:', d.zone, 'current zone:', currentZone, 'match:', d.zone === currentZone);
    if (d.zone && d.zone !== currentZone) {
      const msg = currentZone === '--'
        ? `/who detected in "${d.zone}". Set this as the current zone?`
        : `/who detected in "${d.zone}" but current zone is "${currentZone}".\n\nHas the raid moved to ${d.zone}?`;
      if (confirm(msg)) {
        $('live-zone').textContent = d.zone;
        try {
          await fetch('/api/live/zone', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ zone: d.zone }),
          });
        } catch {}
      }
    }

    try {
      console.log('[attendance] fetching voice...');
      await fetchVoiceMembers();
      console.log('[attendance] voice fetched, voiceMembers:', voiceMembers?.length);
      await renderSplitAttendance(d.allPlayers, d.timestamp);
      console.log('[attendance] render complete');
      refreshVoicePanel();
    } catch (err) {
      console.error('[attendance handler error]', err);
    }
  });

  liveSource.addEventListener('attendance-update', async e => {
    const d = JSON.parse(e.data);
    await fetchVoiceMembers();
    await renderSplitAttendance(d.allPlayers, d.timestamp);
  });

  liveSource.addEventListener('loot', e => {
    const d = JSON.parse(e.data);
    console.log('[SSE loot]', d.itemName, d.playerName);
    // Skip items on the client-side ignore list
    if ((config.ignoredItems || []).some(i => i.toLowerCase() === d.itemName.toLowerCase())) return;
    const count = parseInt($('live-loot-count').textContent, 10) + 1;
    const idx = count - 1;
    $('live-loot-count').textContent = count;
    const div = document.createElement('div');
    div.className = 'loot-item';
    div.dataset.index = idx;
    div.dataset.looter = d.playerName || '?';
    div.dataset.timestamp = d.timestamp || '';
    div.innerHTML = renderLootEntry(idx, d.playerName || '?', null, d.itemName, d.timestamp);
    const isStarred = (config.starredItems || []).some(s => s.toLowerCase() === d.itemName.toLowerCase());
    if (isStarred) div.classList.add('loot-starred');
    $('live-loot').prepend(div);
  });

  liveSource.addEventListener('loot-update', e => {
    const d = JSON.parse(e.data);
    const div = $('live-loot').querySelector(`[data-index="${d.index}"]`);
    if (!div) return;
    const looter = div.dataset.looter;
    const timestamp = div.dataset.timestamp || '';
    const itemEl = div.querySelector('.loot-name');
    const itemName = itemEl ? itemEl.textContent : '';
    div.innerHTML = renderLootEntry(d.index, looter, d.awardedTo, itemName, timestamp);
  });

  liveSource.addEventListener('item-ignored', e => {
    const d = JSON.parse(e.data);
    removeIgnoredItemsFromFeed(d.itemName);
    // Also update local config so new loot items don't render if they match
    if (!config.ignoredItems) config.ignoredItems = [];
    if (!config.ignoredItems.some(i => i.toLowerCase() === d.itemName.toLowerCase())) {
      config.ignoredItems.push(d.itemName);
    }
  });

  liveSource.addEventListener('autosave', e => {
    const d = JSON.parse(e.data);
    const el = $('live-autosave-status');
    const time = new Date(d.timestamp).toLocaleTimeString();
    if (d.success) {
      el.textContent = `Auto-saved to Raid #${d.raidId} at ${time}`;
      el.className = 'autosave-status success';
    } else {
      el.textContent = `Auto-save failed at ${time}`;
      el.className = 'autosave-status error';
    }
  });

  liveSource.addEventListener('raid-ended', e => {
    const d = JSON.parse(e.data);
    const time = new Date(d.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    $('btn-end-raid').textContent = `Ended at ${time}`;
    $('btn-end-raid').disabled = true;
  });

  liveSource.addEventListener('stopped', () => {
    cleanupLive();
  });

  liveSource.addEventListener('error', e => {
    let msg = 'Error';
    try { msg = JSON.parse(e.data).message; } catch {}
    $('live-status-text').textContent = msg;
  });

  liveSource.onerror = () => {
    cleanupLive();
    $('live-status-text').textContent = 'Connection lost';
  };
}

async function stopLive() {
  try {
    await fetch('/api/live/stop', { method: 'POST' });
  } catch {}
  cleanupLive();
}

async function renderSplitAttendance(players, whoTimestamp) {
  // Build voice lookup
  const voiceNames = new Set();
  const discordMap = new Map();
  if (voiceMembers) {
    for (const vm of voiceMembers) {
      const chars = vm.characters || (vm.character ? [vm.character] : []);
      for (const ch of chars) {
        voiceNames.add(ch.toLowerCase());
        discordMap.set(ch.toLowerCase(), vm.displayName);
      }
    }
  }

  const linked = [];
  const unlinked = [];

  for (const p of players) {
    const key = p.name.toLowerCase();
    const discordName = discordMap.get(key) || null;
    if (p.linked || discordName) {
      linked.push({ ...p, discordName: discordName || '', validated: !!p.validated, inWho: !!p.inWho, inVoice: !!p.inVoice });
    } else {
      unlinked.push(p);
    }
  }

  console.log('[render] linked:', linked.length, 'unlinked:', unlinked.length);
  $('live-attend-count').textContent = linked.length;
  $('live-unlinked-count').textContent = unlinked.length;

  // Render linked attendance
  $('live-attendance').innerHTML = linked.map(p => {
    const exited = p.exitTime != null;
    const time = exited
      ? new Date(p.exitTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date(p.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const exitClass = exited ? ' attend-exited' : '';
    const exitLabel = exited ? 'exited ' : '';
    let icon;
    if (p.inWho && p.inVoice) {
      icon = '<span class="status-icon status-confirmed" title="In zone + voice">&#10003;</span> ';
    } else if (p.inVoice) {
      icon = '<span class="status-icon status-voice" title="In voice only">&#9679;</span> ';
    } else if (p.inWho) {
      icon = '<span class="status-icon status-zone" title="In zone only">&#9651;</span> ';
    } else {
      icon = '<span class="status-icon status-missing" title="Not in zone or voice">&#10007;</span> ';
    }
    const exitBtn = exited
      ? `<span class="attend-undo" title="Undo exit" onclick="attendAction('${p.name}','clear-exit')">\u21a9</span>`
      : `<span class="attend-exit" title="Mark as exited" onclick="attendAction('${p.name}','exit')">\u23f9</span>`;
    const removeBtn = `<span class="attend-remove" title="Remove player" onclick="attendAction('${p.name}','remove')">\u2715</span>`;
    const discordTag = `<span class="attend-discord">${p.discordName}</span>`;
    const zoneTag = p.zones && p.zones.length > 0
      ? `<span class="attend-zones">${p.zones.join(', ')}</span>`
      : '';
    const staleClass = !p.validated && !exited ? ' attend-stale' : '';
    return `<div class="attend-row${exitClass}${staleClass}">${icon}<span class="attend-name">${p.name}</span>${discordTag}${zoneTag}<span class="attend-actions">${exitBtn}${removeBtn}</span><span class="attend-time">${exitLabel}${time}</span></div>`;
  }).join('');

  // Render unlinked players
  $('live-unlinked').innerHTML = unlinked.map(p => {
    const exited = p.exitTime != null;
    const time = exited
      ? new Date(p.exitTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      : new Date(p.lastSeen).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const exitClass = exited ? ' attend-exited' : '';
    const exitLabel = exited ? 'exited ' : '';
    const exitBtn = exited
      ? `<span class="attend-undo" title="Undo exit" onclick="attendAction('${p.name}','clear-exit')">\u21a9</span>`
      : `<span class="attend-exit" title="Mark as exited" onclick="attendAction('${p.name}','exit')">\u23f9</span>`;
    const removeBtn = `<span class="attend-remove" title="Remove player" onclick="attendAction('${p.name}','remove')">\u2715</span>`;
    const linkBtn = `<span class="attend-link" title="Link to Discord user" onclick="linkPlayer('${p.name}')">Link</span>`;
    return `<div class="attend-row${exitClass}"><span class="attend-name">${p.name}</span>${linkBtn}<span class="attend-actions">${exitBtn}${removeBtn}</span><span class="attend-time">${exitLabel}${time}</span></div>`;
  }).join('');
}

async function refreshVoicePanel() {
  await fetchVoiceMembers();
  if (!voiceMembers) {
    $('live-voice').innerHTML = '<div class="voice-unavailable">Voice check unavailable</div>';
    $('live-voice-count').textContent = '0';
    return;
  }
  $('live-voice-count').textContent = voiceMembers.length;
  $('live-voice').innerHTML = voiceMembers.map(vm => {
    const chars = vm.characters || (vm.character ? [vm.character] : []);
    const charTag = chars.length > 0
      ? `<span class="voice-char">${chars.join(', ')}</span>`
      : `<span class="voice-nochar">no character linked</span>`;
    return `<div class="voice-row"><span class="voice-discord">${vm.displayName}</span>${charTag}</div>`;
  }).join('');
}


window.linkPlayer = async function(characterName) {
  // Refresh voice members to get latest list
  await fetchVoiceMembers();

  if (!voiceMembers || voiceMembers.length === 0) {
    const rows = $('live-unlinked').querySelectorAll('.attend-row');
    for (const row of rows) {
      const nameEl = row.querySelector('.attend-name');
      if (nameEl && nameEl.textContent === characterName) {
        const linkEl = row.querySelector('.attend-link');
        if (linkEl) {
          linkEl.textContent = 'Voice unavailable';
          linkEl.style.color = 'var(--red)';
          setTimeout(() => { linkEl.textContent = 'Link'; linkEl.style.color = ''; }, 3000);
        }
        break;
      }
    }
    return;
  }

  const options = voiceMembers.map(vm => {
    const chars = vm.characters || (vm.character ? [vm.character] : []);
    const label = chars.length > 0 ? `${vm.displayName} (${chars.join(', ')})` : vm.displayName;
    return `<option value="${vm.discordId}" data-tag="${vm.displayName}">${label}</option>`;
  }).join('');

  // Replace the Link button (or existing wrapper) with a dropdown
  const rows = $('live-unlinked').querySelectorAll('.attend-row');
  for (const row of rows) {
    const nameEl = row.querySelector('.attend-name');
    if (nameEl && nameEl.textContent === characterName) {
      const existing = row.querySelector('.link-inline') || row.querySelector('.attend-link');
      if (!existing) return;
      const wrapper = document.createElement('span');
      wrapper.className = 'link-inline';
      wrapper.innerHTML = `<select class="link-select"><option value="">-- Select --</option>${options}</select><button class="btn-sm btn-link-confirm">OK</button><button class="btn-sm btn-link-cancel">X</button>`;
      existing.replaceWith(wrapper);

      const sel = wrapper.querySelector('select');
      const btn = wrapper.querySelector('.btn-link-confirm');
      const cancelBtn = wrapper.querySelector('.btn-link-cancel');

      cancelBtn.addEventListener('click', () => {
        const link = document.createElement('span');
        link.className = 'attend-link';
        link.title = 'Link to Discord user';
        link.onclick = () => linkPlayer(characterName);
        link.textContent = 'Link';
        wrapper.replaceWith(link);
      });

      btn.addEventListener('click', async () => {
        const discordId = sel.value;
        const discordTag = sel.selectedOptions[0]?.dataset.tag;
        if (!discordId) return;
        try {
          const res = await fetch('/api/link-character', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ characterName, discordId, discordTag }),
          });
          if (res.ok) {
            // Refresh voice members to pick up the new link, then re-render
            await fetchVoiceMembers();
            await refreshVoicePanel();
            // Trigger a re-render of attendance by fetching current state
            try {
              const sessionRes = await fetch('/api/live/session');
              if (sessionRes.ok) {
                const session = await sessionRes.json();
                const allPlayers = session.attendance.map(a => ({
                  name: a.name,
                  lastSeen: a.lastSeen || a.firstSeen,
                  exitTime: a.exitTime || null,
                }));
                await renderSplitAttendance(allPlayers);
              }
            } catch {}
          } else {
            const data = await res.json();
            alert(data.error || 'Failed to link');
          }
        } catch {
          alert('Failed to link character');
        }
      });
      break;
    }
  }
};

window.attendAction = async function(name, action) {
  if (action === 'remove' && !confirm(`Remove ${name} from attendance?`)) return;
  if (action === 'exit' && !confirm(`Mark ${name} as exited?`)) return;
  try {
    const res = await fetch('/api/live/attendance', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, action }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed');
    }
  } catch {
    alert('Failed to update attendance');
  }
};

async function endRaid() {
  if (!confirm('Mark raid as ended? This sets the end timestamp.')) return;
  try {
    const res = await fetch('/api/live/end-raid', { method: 'POST' });
    if (res.ok) {
      const d = await res.json();
      const time = new Date(d.endTime).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      $('btn-end-raid').textContent = `Ended at ${time}`;
      $('btn-end-raid').disabled = true;
    }
  } catch {
    alert('Failed to end raid');
  }
}

function cleanupLive() {
  if (liveSource) { liveSource.close(); liveSource = null; }
  if (voiceInterval) { clearInterval(voiceInterval); voiceInterval = null; }
  liveRunning = false;
  $('btn-live-toggle').textContent = 'Start Watching';
  $('chk-dev-mode').disabled = false;
  $('zone-inline').classList.add('hidden');
  $('live-status').classList.add('hidden');
  $('live-status-text').textContent = 'Watching...';
  $('btn-end-raid').classList.add('hidden');
}

function renderLootEntry(index, looter, awardedTo, itemName, timestamp) {
  const ignoreBtn = `<span class="loot-ignore" title="Ignore this item" onclick="ignoreLootItem('${itemName.replace(/'/g, "\\'")}')">X</span>`;
  const timeStr = timestamp ? `<span class="loot-time">${new Date(timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>` : '';
  if (awardedTo && awardedTo !== looter) {
    return `<span class="loot-player loot-original">${looter}</span> ` +
      `<span class="loot-arrow">\u2192</span> ` +
      `<span class="loot-awarded" title="Click to change" onclick="editLootPlayer(${index})">${awardedTo}</span> ` +
      ` looted <span class="loot-name">${itemName}</span> ` +
      `<span class="loot-undo" title="Undo reassign" onclick="undoLootPlayer(${index})"> \u2715</span> ` +
      ignoreBtn + timeStr;
  }
  return `<span class="loot-player" title="Click to reassign" onclick="editLootPlayer(${index})">${looter}</span>` +
    ` looted <span class="loot-name">${itemName}</span> ` +
    ignoreBtn + timeStr;
}

window.editLootPlayer = async function(index) {
  const div = $('live-loot').querySelector(`[data-index="${index}"]`);
  if (!div) return;
  const clickedEl = div.querySelector('.loot-awarded') || div.querySelector('.loot-player');
  const currentAwarded = div.querySelector('.loot-awarded')?.textContent || '';

  const input = document.createElement('input');
  input.type = 'text';
  input.value = currentAwarded;
  input.placeholder = 'Awarded to...';
  input.className = 'loot-edit-input';
  clickedEl.replaceWith(input);
  input.focus();
  input.select();

  let committed = false;
  async function commit() {
    if (committed) return;
    committed = true;
    const newName = input.value.trim();
    const looter = div.dataset.looter;
    const timestamp = div.dataset.timestamp || '';
    const itemEl = div.querySelector('.loot-name');
    const itemName = itemEl ? itemEl.textContent : '';

    if (!newName || newName === looter) {
      // Clear awardedTo — revert to original
      div.innerHTML = renderLootEntry(index, looter, null, itemName, timestamp);
      if (newName === looter) {
        try {
          await fetch('/api/live/loot', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ index, awardedTo: '' }),
          });
        } catch {}
      }
      return;
    }

    try {
      const res = await fetch('/api/live/loot', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ index, awardedTo: newName }),
      });
      if (!res.ok) { alert('Failed to update loot'); return; }
    } catch {
      alert('Failed to update loot');
      return;
    }
    div.innerHTML = renderLootEntry(index, looter, newName, itemName, timestamp);
  }

  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') commit();
    if (e.key === 'Escape') { input.value = ''; commit(); }
  });
  input.addEventListener('blur', commit);
};

window.undoLootPlayer = async function(index) {
  try {
    await fetch('/api/live/loot', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ index, awardedTo: '' }),
    });
  } catch {
    alert('Failed to undo');
  }
};

window.ignoreLootItem = async function(itemName) {
  if (!itemName) return;
  try {
    const res = await fetch('/api/live/ignore-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemName }),
    });
    if (!res.ok) {
      const data = await res.json();
      alert(data.error || 'Failed to ignore item');
    }
    // SSE broadcast will handle removing items from all clients
  } catch {
    alert('Failed to ignore item');
  }
};

function removeIgnoredItemsFromFeed(itemName) {
  const lootContainer = $('live-loot');
  const items = lootContainer.querySelectorAll('.loot-item');
  let removed = 0;
  items.forEach(div => {
    const nameEl = div.querySelector('.loot-name');
    if (nameEl && nameEl.textContent.toLowerCase() === itemName.toLowerCase()) {
      div.remove();
      removed++;
    }
  });
  // Update the loot count
  const current = parseInt($('live-loot-count').textContent, 10) || 0;
  $('live-loot-count').textContent = Math.max(0, current - removed);
}

async function uploadLiveSession() {
  try {
    const res = await fetch('/api/live/session');
    if (!res.ok) { alert('No live session data available.'); return; }
    const session = await res.json();

    $('btn-live-upload').disabled = true;
    $('btn-live-upload').textContent = 'Checking voice...';

    // Fetch voice members and filter attendance
    await fetchVoiceMembers();
    if (voiceMembers !== null) {
      const voiceNames = new Set();
      for (const vm of voiceMembers) {
        if (vm.character) voiceNames.add(vm.character.toLowerCase());
        voiceNames.add(vm.displayName.toLowerCase());
      }
      const before = session.attendance.length;
      session.attendance = session.attendance.filter(a => voiceNames.has(a.name.toLowerCase()));
      const after = session.attendance.length;
      if (before !== after) {
        console.log(`Voice filter: ${before} in log, ${after} confirmed in voice`);
      }
    }

    $('btn-live-upload').textContent = 'Uploading...';

    const submitRes = await fetch('/api/submit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session, character: config.character }),
    });
    const data = await submitRes.json();

    if (submitRes.ok) {
      if (data.action === 'merged') {
        $('btn-live-upload').textContent = `Merged into Raid #${data.raidId}`;
      } else {
        $('btn-live-upload').textContent = `Saved as Raid #${data.raidId}`;
      }
    } else {
      $('btn-live-upload').textContent = data.error || 'Upload failed';
    }
  } catch (err) {
    $('btn-live-upload').textContent = 'Upload failed';
  }

  setTimeout(() => {
    $('btn-live-upload').textContent = 'Upload Session';
    $('btn-live-upload').disabled = false;
  }, 3000);
}

// ── Zone Combo Box ──────────────────────────────────────────────────────────
async function loadZoneList() {
  try {
    const res = await fetch('/api/zones');
    if (res.ok) allZones = await res.json();
  } catch {}
}

function renderZoneTags() {
  const tags = (config.approvedZones || []).slice().sort((a, b) => a.localeCompare(b));
  $('zone-tags').innerHTML = tags.map(z =>
    `<span class="zone-tag">${z}<span class="zone-tag-remove" onclick="removeZone('${z.replace(/'/g, "\\'")}')">&times;</span></span>`
  ).join('');
}

window.removeZone = function(zoneName) {
  config.approvedZones = (config.approvedZones || []).filter(z => z !== zoneName);
  renderZoneTags();
};

window.addZone = function(zoneName) {
  if (!config.approvedZones) config.approvedZones = [];
  if (!config.approvedZones.includes(zoneName)) config.approvedZones.push(zoneName);
  renderZoneTags();
  $('cfg-zone-search').value = '';
  $('zone-dropdown').classList.add('hidden');
};

function setupZoneCombo() {
  const input = $('cfg-zone-search');
  const dropdown = $('zone-dropdown');

  input.addEventListener('input', () => {
    const q = input.value.toLowerCase().trim();
    if (q.length < 1) { dropdown.classList.add('hidden'); return; }
    const selected = new Set((config.approvedZones || []).map(z => z.toLowerCase()));
    const matches = allZones.filter(z =>
      z.long_name.toLowerCase().includes(q) && !selected.has(z.long_name.toLowerCase())
    ).slice(0, 20);
    if (matches.length === 0) { dropdown.classList.add('hidden'); return; }
    dropdown.innerHTML = matches.map(z =>
      `<div class="zone-dropdown-item" onclick="addZone('${z.long_name.replace(/'/g, "\\'")}')">${z.long_name}</div>`
    ).join('');
    dropdown.classList.remove('hidden');
  });

  input.addEventListener('blur', () => {
    setTimeout(() => dropdown.classList.add('hidden'), 200);
  });
}

// ── Item Filters ────────────────────────────────────────────────────────────
function setupItemFilters() {
  $('item-search').addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(doItemSearch, 300);
  });
}

async function doItemSearch() {
  const q = $('item-search').value.trim();
  if (q.length < 2) { $('item-results').innerHTML = ''; return; }

  try {
    const res = await fetch(`/api/items?q=${encodeURIComponent(q)}`);
    if (!res.ok) return;
    const items = await res.json();
    const starred = new Set((config.starredItems || []).map(i => i.toLowerCase()));
    const ignored = new Set((config.ignoredItems || []).map(i => i.toLowerCase()));

    $('item-results').innerHTML = items.map(item => {
      const isStarred = starred.has(item.item_name.toLowerCase());
      const isTrashed = ignored.has(item.item_name.toLowerCase());
      const starClass = isStarred ? ' active' : '';
      const trashClass = isTrashed ? ' active' : '';
      return `<div class="item-row">
        <span class="item-name">${item.item_name}</span>
        <span class="item-actions">
          <span class="item-star${starClass}" title="Mark valuable" onclick="toggleStarItem('${item.item_name.replace(/'/g, "\\'")}')">&#9733;</span>
          <span class="item-trash${trashClass}" title="Ignore item" onclick="toggleTrashItem('${item.item_name.replace(/'/g, "\\'")}')">&#128465;</span>
        </span>
      </div>`;
    }).join('');
  } catch {}
}

window.toggleStarItem = async function(itemName) {
  const starred = (config.starredItems || []).map(i => i.toLowerCase());
  const isStarred = starred.includes(itemName.toLowerCase());
  try {
    const res = await fetch('/api/star-item', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ itemName, starred: !isStarred }),
    });
    if (res.ok) {
      const data = await res.json();
      config.starredItems = data.starredItems;
      doItemSearch();
    }
  } catch {}
};

window.toggleTrashItem = async function(itemName) {
  const ignored = (config.ignoredItems || []).map(i => i.toLowerCase());
  const isIgnored = ignored.includes(itemName.toLowerCase());
  if (isIgnored) {
    config.ignoredItems = config.ignoredItems.filter(i => i.toLowerCase() !== itemName.toLowerCase());
  } else {
    if (!config.ignoredItems) config.ignoredItems = [];
    config.ignoredItems.push(itemName);
  }
  try {
    await fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ignoredItems: config.ignoredItems }),
    });
    doItemSearch();
  } catch {}
};

// ── Raid Group Organizer ────────────────────────────────────────────────────
let raidRoster = [];
let raidGroupsResult = [];
let raidTickInterval = null;
let lastRaidTickFile = null;

function setupRaidGroups() {
  $('btn-generate-groups').addEventListener('click', generateRaidGroups);
  $('btn-copy-commands').addEventListener('click', copyRaidCommands);
  // Start polling for RaidTick files
  checkForRaidTick();
  raidTickInterval = setInterval(checkForRaidTick, 15000);
}

async function checkForRaidTick() {
  try {
    const res = await fetch('/api/raidtick');
    if (!res.ok) return;
    const data = await res.json();
    if (data.file === lastRaidTickFile) return;
    lastRaidTickFile = data.file;

    const lines = data.content.split(/\r?\n/).filter(l => l.trim());
    raidRoster = [];
    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split('\t');
      if (parts.length < 3) continue;
      raidRoster.push({ name: parts[0], level: parseInt(parts[1], 10) || 0, class: parts[2] });
    }
    if (raidRoster.length === 0) return;

    $('raidtick-status').textContent = `Loaded: ${data.file} (${raidRoster.length} players)`;
    renderRosterSummary();
    $('btn-generate-groups').disabled = false;
    $('raidtick-roster').classList.remove('hidden');
  } catch {}
}

function renderRosterSummary() {
  const classCounts = {};
  for (const p of raidRoster) {
    classCounts[p.class] = (classCounts[p.class] || 0) + 1;
  }
  const sorted = Object.entries(classCounts).sort((a, b) => b[1] - a[1]);
  const parts = sorted.map(([cls, count]) => `<strong>${count}</strong> ${cls}`);
  $('roster-summary').innerHTML = `<strong>${raidRoster.length}</strong> players: ${parts.join(', ')}`;
}

const CLASS_CATEGORIES = {
  'Warrior': 'tank', 'Paladin': 'tank', 'Shadow Knight': 'tank',
  'Monk': 'melee', 'Rogue': 'melee', 'Ranger': 'melee', 'Berserker': 'melee', 'Beastlord': 'melee',
  'Wizard': 'caster', 'Magician': 'caster', 'Necromancer': 'caster', 'Enchanter': 'caster',
  'Cleric': 'healer', 'Druid': 'healer', 'Shaman': 'healer',
  'Bard': 'bard',
};

// Special players treated as specific roles regardless of class
const PLAYER_OVERRIDES = {
  'Gleipnir': 'tank',
};

function assignRaidGroups(roster) {
  const MAX_SIZE = 6;
  const groups = [];
  let groupNum = 1;

  // Bucket players by category (with player-specific overrides)
  const buckets = { tank: [], melee: [], caster: [], healer: [], bard: [], unknown: [] };
  for (const p of roster) {
    const override = PLAYER_OVERRIDES[p.name];
    const cat = override || CLASS_CATEGORIES[p.class] || 'unknown';
    buckets[cat].push(p);
  }

  // Sort each bucket by class then level descending for consistency
  for (const cat of Object.keys(buckets)) {
    buckets[cat].sort((a, b) => a.class.localeCompare(b.class) || b.level - a.level);
  }

  // ── Group 1: Tank group ──
  const tankGroup = { number: groupNum++, label: 'Tanks', members: [] };

  // Add all tanks
  for (const p of buckets.tank) {
    if (tankGroup.members.length < MAX_SIZE) tankGroup.members.push(p);
  }
  buckets.tank = buckets.tank.filter(p => !tankGroup.members.includes(p));

  // Torpor rule: if tanks are Paladin/SK (no Warrior), add a Shaman for Torpor
  const hasWarrior = tankGroup.members.some(p => p.class === 'Warrior');
  const shamanIdx = buckets.healer.findIndex(p => p.class === 'Shaman');
  if (!hasWarrior && shamanIdx !== -1 && tankGroup.members.length < MAX_SIZE) {
    tankGroup.members.push(buckets.healer.splice(shamanIdx, 1)[0]);
  }

  // Fill remaining tank group with healers
  while (tankGroup.members.length < MAX_SIZE && buckets.healer.length > 0) {
    tankGroup.members.push(buckets.healer.shift());
  }

  groups.push(tankGroup);

  // ── Build melee groups by class stacking ──
  const meleeGroups = buildClassGroups(buckets.melee, 'Melee', MAX_SIZE);

  // ── Build caster groups by class stacking ──
  const casterGroups = buildClassGroups(buckets.caster, 'Caster', MAX_SIZE);

  // ── Distribute bards: melee first, then tank, then casters ──
  for (const g of meleeGroups) {
    if (buckets.bard.length === 0) break;
    if (g.members.length < MAX_SIZE) {
      g.members.push(buckets.bard.shift());
    }
  }
  // Bard in tank group (if not already there and bards remain)
  if (buckets.bard.length > 0 && tankGroup.members.length < MAX_SIZE && !tankGroup.members.some(m => CLASS_CATEGORIES[m.class] === 'bard')) {
    tankGroup.members.push(buckets.bard.shift());
  }
  for (const g of casterGroups) {
    if (buckets.bard.length === 0) break;
    if (g.members.length < MAX_SIZE) {
      g.members.push(buckets.bard.shift());
    }
  }

  // ── Distribute healers: shamans first (max 1 per group), then other healers ──
  const allDpsGroups = [...meleeGroups, ...casterGroups];
  const shamans = buckets.healer.filter(p => p.class === 'Shaman');
  const otherHealers = buckets.healer.filter(p => p.class !== 'Shaman');

  // One shaman per group (skip tank group which may already have one)
  const hasShamanInTank = tankGroup.members.some(m => m.class === 'Shaman');
  const shamanTargets = hasShamanInTank ? allDpsGroups : [tankGroup, ...allDpsGroups];
  for (const g of shamanTargets) {
    if (shamans.length === 0) break;
    if (g.members.length < MAX_SIZE && !g.members.some(m => m.class === 'Shaman')) {
      g.members.push(shamans.shift());
    }
  }

  // Distribute other healers evenly
  for (const g of allDpsGroups) {
    if (otherHealers.length === 0) break;
    if (g.members.length < MAX_SIZE) {
      g.members.push(otherHealers.shift());
    }
  }

  // Second pass: remaining healers (shamans + others) into any group with space
  const remainingHealers = [...shamans, ...otherHealers];
  for (const g of [tankGroup, ...allDpsGroups]) {
    if (remainingHealers.length === 0) break;
    if (g.members.length < MAX_SIZE) {
      g.members.push(remainingHealers.shift());
    }
  }
  buckets.healer = remainingHealers;

  // Number and add melee/caster groups
  for (const g of meleeGroups) {
    g.number = groupNum++;
    groups.push(g);
  }
  for (const g of casterGroups) {
    g.number = groupNum++;
    groups.push(g);
  }

  // ── Handle remaining bards, healers, unknown, overflow tanks ──
  const overflow = [...buckets.bard, ...buckets.healer, ...buckets.tank, ...buckets.unknown];
  if (overflow.length > 0) {
    // Try to fill existing groups first
    for (const p of [...overflow]) {
      let placed = false;
      for (const g of groups) {
        if (g.members.length < MAX_SIZE) {
          g.members.push(p);
          overflow.splice(overflow.indexOf(p), 1);
          placed = true;
          break;
        }
      }
    }
    // Create overflow groups for any remaining
    const overflowGroups = buildClassGroups(overflow, 'Support', MAX_SIZE);
    for (const g of overflowGroups) {
      g.number = groupNum++;
      groups.push(g);
    }
  }

  return groups;
}

function buildClassGroups(players, labelPrefix, maxSize) {
  if (players.length === 0) return [];

  const groups = [];

  // Group by class first
  const byClass = {};
  for (const p of players) {
    if (!byClass[p.class]) byClass[p.class] = [];
    byClass[p.class].push(p);
  }

  // Sort classes by count descending so the largest class stacks first
  const classEntries = Object.entries(byClass).sort((a, b) => b[1].length - a[1].length);

  // Pack into groups, stacking same classes together
  let currentGroup = null;
  for (const [className, classPlayers] of classEntries) {
    for (const p of classPlayers) {
      if (!currentGroup || currentGroup.members.length >= maxSize) {
        currentGroup = { number: 0, label: labelPrefix, members: [] };
        groups.push(currentGroup);
      }
      currentGroup.members.push(p);
    }
  }

  // Consolidate: if the last group is less than half full and there are other groups, merge into previous groups
  if (groups.length > 1) {
    const last = groups[groups.length - 1];
    if (last.members.length <= maxSize / 2) {
      groups.pop();
      for (const p of last.members) {
        let placed = false;
        for (const g of groups) {
          if (g.members.length < maxSize) {
            g.members.push(p);
            placed = true;
            break;
          }
        }
        if (!placed) {
          // Put them back in a new group
          groups.push({ number: 0, label: labelPrefix, members: [p] });
        }
      }
    }
  }

  return groups;
}

function generateRaidGroups() {
  if (raidRoster.length === 0) { alert('No roster loaded'); return; }
  try {
  raidGroupsResult = assignRaidGroups(raidRoster);

  // Preview cards
  $('raid-groups-preview').innerHTML = raidGroupsResult.map(g => {
    const members = g.members.map(m =>
      `<div class="group-member"><span>${m.name}</span><span class="member-class">${m.level} ${m.class}</span></div>`
    ).join('');
    return `<div class="group-card"><h4>Group ${g.number}: ${g.label} (${g.members.length})</h4>${members}</div>`;
  }).join('');

  // First move everyone to ungrouped (group 0) for a clean slate
  const resetCommands = raidRoster.map(p => `/rm ${p.name} 0`).join('\n');
  // Then assign to groups
  const assignCommands = raidGroupsResult.flatMap(g =>
    g.members.map(m => `/rm ${m.name} ${g.number}`)
  ).join('\n');
  const commands = resetCommands + '\n' + assignCommands;
  $('raid-commands').textContent = commands;

  $('raid-groups-output').classList.remove('hidden');
  $('btn-copy-commands').classList.remove('hidden');
  } catch (err) { alert('Error generating groups: ' + err.message); console.error(err); }
}

function copyRaidCommands() {
  const text = $('raid-commands').textContent;
  navigator.clipboard.writeText(text).then(() => {
    $('btn-copy-commands').textContent = 'Copied!';
    setTimeout(() => { $('btn-copy-commands').textContent = 'Copy Commands'; }, 2000);
  }).catch(() => {
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
