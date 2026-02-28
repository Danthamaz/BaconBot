'use strict';

// ── State ────────────────────────────────────────────────────────────────────
let config       = { character: '', timezone: 'America/Phoenix', eqFolder: '' };
let logFile      = null;
let sessions     = [];
let voiceMembers = null; // null = not fetched, [] = fetched but empty
let liveSource   = null;
let liveRunning  = false;

// ── DOM refs ─────────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id);

// ── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  setupTabs();
  setupSettings();
  setupParse();
  setupLive();
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

    // Approved zones
    $('cfg-zones').value = (config.approvedZones || []).join('\n');

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

  // Approved zones
  config.approvedZones = $('cfg-zones').value
    .split('\n')
    .map(z => z.trim())
    .filter(z => z.length > 0);

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
    const res = await fetch('/api/voice-members');
    if (res.ok) {
      const data = await res.json();
      voiceMembers = data.members || [];
    } else {
      voiceMembers = null; // voice check unavailable
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
    if (vm.character) voiceNames.add(vm.character.toLowerCase());
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

  const params = new URLSearchParams({
    file:      logFile,
    timezone:  config.timezone,
    character: config.character,
  });

  liveSource = new EventSource('/api/live?' + params.toString());
  liveRunning = true;

  $('btn-live-toggle').textContent = 'Stop Watching';
  $('live-status').classList.remove('hidden');
  $('live-panels').classList.remove('hidden');
  $('btn-live-upload').classList.remove('hidden');
  $('live-zone').textContent = '--';
  $('live-attendance').innerHTML = '';
  $('live-loot').innerHTML = '';
  $('live-attend-count').textContent = '0';
  $('live-loot-count').textContent = '0';

  liveSource.addEventListener('started', () => {
    $('live-status-text').textContent = 'Watching for changes...';
  });

  liveSource.addEventListener('zone', e => {
    const d = JSON.parse(e.data);
    $('live-zone').textContent = d.zone;
  });

  liveSource.addEventListener('attendance', async e => {
    const d = JSON.parse(e.data);
    $('live-attend-count').textContent = d.total;

    // Fetch voice members to cross-reference
    await fetchVoiceMembers();
    const voiceNames = new Set();
    if (voiceMembers) {
      for (const vm of voiceMembers) {
        if (vm.character) voiceNames.add(vm.character.toLowerCase());
        voiceNames.add(vm.displayName.toLowerCase());
      }
    }

    const hasVoice = voiceMembers !== null;
    $('live-attendance').innerHTML = d.allPlayers.map(p => {
      const inVoice = hasVoice && voiceNames.has(p.toLowerCase());
      const dot = hasVoice ? `<span class="dot ${inVoice ? 'green' : 'red'}"></span> ` : '';
      const cls = hasVoice && !inVoice ? 'style="opacity:0.4"' : '';
      return `<div ${cls}>${dot}${p}</div>`;
    }).join('');

    const el = $('live-attendance');
    el.scrollTop = el.scrollHeight;
  });

  liveSource.addEventListener('loot', e => {
    const d = JSON.parse(e.data);
    const count = parseInt($('live-loot-count').textContent, 10) + 1;
    $('live-loot-count').textContent = count;
    const div = document.createElement('div');
    div.className = 'loot-item';
    div.innerHTML = `<span class="loot-player">${d.playerName || '?'}</span> looted <span class="loot-name">${d.itemName}</span>`;
    $('live-loot').appendChild(div);
    $('live-loot').scrollTop = $('live-loot').scrollHeight;
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

function cleanupLive() {
  if (liveSource) { liveSource.close(); liveSource = null; }
  liveRunning = false;
  $('btn-live-toggle').textContent = 'Start Watching';
  $('live-status').classList.add('hidden');
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
