// Styl popup controller

const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // r=52 ≈ 326.73

// Duration presets per timer mode
const DURATION_PRESETS = {
  focus:     [15, 20, 25, 30, 45, 60, 90],
  break:     [5, 10, 15],
  longBreak: [10, 15, 20, 25, 30],
};

// Site-block presets — toggled as a group
const BLOCK_PRESETS = {
  social: {
    label: 'Social',
    sites: [
      'instagram.com', 'facebook.com', 'twitter.com', 'x.com',
      'tiktok.com', 'reddit.com', 'snapchat.com', 'pinterest.com',
      'threads.net', 'linkedin.com', 'tumblr.com',
    ],
  },
  video: {
    label: 'Video',
    sites: [
      'youtube.com', 'netflix.com', 'twitch.tv',
      'hulu.com', 'disneyplus.com', 'primevideo.com', 'vimeo.com',
    ],
  },
  news: {
    label: 'News',
    sites: [
      'cnn.com', 'bbc.com', 'nytimes.com', 'buzzfeed.com',
      'theguardian.com', 'huffpost.com', 'dailymail.co.uk',
    ],
  },
};

let port       = null;
let state      = null;
let blockState = null;
let isEditing  = false;

// ── Connection ────────────────────────────────────────────────────────────────

function connect() {
  port = browser.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((msg) => {
    if (msg.type === 'stateUpdate') {
      state = msg.state;
      render();
      if (msg.event === 'timerComplete') playChime();
    } else if (msg.type === 'blockStateUpdate') {
      blockState = msg.blockState;
      renderBlockPanel();
      updateShieldIndicator();
    }
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 300));
}

// ── Shield indicator ──────────────────────────────────────────────────────────

function updateShieldIndicator() {
  const active = blockState?.enabled && blockState?.sites?.length > 0;
  document.getElementById('shield-btn').classList.toggle('active', active);
}

// ── Panel switching ───────────────────────────────────────────────────────────

document.getElementById('shield-btn').addEventListener('click', () => {
  document.getElementById('timer-view').classList.add('hidden');
  document.getElementById('block-panel').classList.remove('hidden');
});

document.getElementById('block-back-btn').addEventListener('click', () => {
  document.getElementById('block-panel').classList.add('hidden');
  document.getElementById('timer-view').classList.remove('hidden');
});

// ── Timer rendering ───────────────────────────────────────────────────────────

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function totalFor(mode) {
  if (!state) return 25 * 60;
  switch (mode) {
    case 'focus':     return state.focusDuration;
    case 'break':     return state.breakDuration;
    case 'longBreak': return state.longBreakDuration;
    default:          return state.focusDuration;
  }
}

function render() {
  if (!state) return;

  document.querySelectorAll('.mode-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.mode === state.mode));

  if (!isEditing) {
    document.getElementById('time-text').textContent = fmt(state.timeRemaining);
  }

  const total    = totalFor(state.mode);
  const progress = state.timeRemaining / total;
  const offset   = (1 - progress) * RING_CIRCUMFERENCE;
  const ring     = document.getElementById('progress-ring');
  ring.style.strokeDashoffset = offset;
  ring.className = 'ring-fg' +
    (state.mode === 'break'     ? ' break-mode' :
     state.mode === 'longBreak' ? ' long-mode'  : '');

  document.getElementById('start-pause-btn').textContent =
    state.isRunning ? 'Pause' : 'Start';

  document.getElementById('add-min-btn').classList.toggle('hidden', !state.isRunning);

  const dots = document.getElementById('sessions-dots');
  dots.innerHTML = '';
  const cyclePos = state.sessionsCompleted % 4;
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement('div');
    dot.className = 'session-dot' + (i < cyclePos ? ' filled' : '');
    dots.appendChild(dot);
  }
  document.getElementById('sessions-label').textContent =
    `${state.sessionsCompleted} session${state.sessionsCompleted !== 1 ? 's' : ''} completed`;
}

// ── Edit mode (click timer to change duration) ────────────────────────────────

function enterEditMode() {
  if (isEditing) return;
  isEditing = true;
  if (state?.isRunning) port.postMessage({ type: 'pause' });

  const mode    = state?.mode || 'focus';
  const minutes = Math.round(totalFor(mode) / 60);

  document.getElementById('time-text').classList.add('hidden');
  document.getElementById('time-editor').classList.remove('hidden');
  const input = document.getElementById('time-edit');
  input.value = minutes;
  input.focus();
  input.select();

  buildDurationPresets(mode, minutes);
  document.getElementById('preset-bar').classList.remove('hidden');
}

function exitEditMode(save = true) {
  if (!isEditing) return;
  isEditing = false;
  if (save) {
    const raw     = parseInt(document.getElementById('time-edit').value, 10);
    const minutes = isNaN(raw) ? null : Math.min(Math.max(raw, 1), 180);
    if (minutes) saveMinutes(minutes);
  }
  document.getElementById('time-text').classList.remove('hidden');
  document.getElementById('time-editor').classList.add('hidden');
  document.getElementById('preset-bar').classList.add('hidden');
}

function saveMinutes(minutes) {
  const secs = minutes * 60;
  const mode  = state?.mode || 'focus';
  port.postMessage({
    type:              'updateSettings',
    focusDuration:     mode === 'focus'     ? secs : state.focusDuration,
    breakDuration:     mode === 'break'     ? secs : state.breakDuration,
    longBreakDuration: mode === 'longBreak' ? secs : state.longBreakDuration,
  });
}

function buildDurationPresets(mode, currentMinutes) {
  const bar = document.getElementById('preset-bar');
  bar.innerHTML = '';
  (DURATION_PRESETS[mode] || DURATION_PRESETS.focus).forEach((val) => {
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (val === currentMinutes ? ' active' : '');
    chip.textContent = `${val}m`;
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', () => applyDurationPreset(val));
    bar.appendChild(chip);
  });
}

function applyDurationPreset(val) {
  document.getElementById('time-edit').value = val;
  exitEditMode(true);
}

// ── Block panel rendering ─────────────────────────────────────────────────────

function renderBlockPanel() {
  if (!blockState) return;

  // Master toggle
  document.getElementById('block-enabled').checked = blockState.enabled;

  // Preset chips — three states: all-on / some-on / off
  document.querySelectorAll('.bp-preset').forEach((chip) => {
    const preset = BLOCK_PRESETS[chip.dataset.preset];
    if (!preset) return;
    const count = preset.sites.filter((s) => blockState.sites.includes(s)).length;
    chip.classList.toggle('all-on',  count === preset.sites.length);
    chip.classList.toggle('some-on', count > 0 && count < preset.sites.length);
  });

  // Site list
  const list = document.getElementById('bp-site-list');
  list.innerHTML = '';

  if (blockState.sites.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'bp-empty';
    empty.textContent = 'No sites blocked yet.';
    list.appendChild(empty);
    return;
  }

  // Sort alphabetically for readability
  [...blockState.sites].sort().forEach((site) => {
    const row = document.createElement('div');
    row.className = 'bp-site-row';

    const domain = document.createElement('span');
    domain.className = 'bp-site-domain';
    domain.textContent = site;

    const rm = document.createElement('button');
    rm.className = 'bp-site-remove';
    rm.textContent = '×';
    rm.title = `Remove ${site}`;
    rm.addEventListener('click', () => removeSite(site));

    row.appendChild(domain);
    row.appendChild(rm);
    list.appendChild(row);
  });
}

// ── Block state helpers ───────────────────────────────────────────────────────

function setSites(sites) {
  port.postMessage({ type: 'setBlockedSites', sites });
}

function removeSite(site) {
  setSites(blockState.sites.filter((s) => s !== site));
}

function togglePreset(presetKey) {
  const preset = BLOCK_PRESETS[presetKey];
  if (!preset) return;

  const allOn = preset.sites.every((s) => blockState.sites.includes(s));
  let next = [...blockState.sites];

  if (allOn) {
    // Remove every site in this category
    next = next.filter((s) => !preset.sites.includes(s));
  } else {
    // Add any missing sites from this category
    preset.sites.forEach((s) => { if (!next.includes(s)) next.push(s); });
  }
  setSites(next);
}

function addCustomSite(raw) {
  // Strip protocol, www, and path — keep bare hostname
  const domain = raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .split('/')[0]
    .split('?')[0];

  if (!domain || blockState.sites.includes(domain)) return false;
  setSites([...blockState.sites, domain]);
  return true;
}

// ── Block panel event wiring ──────────────────────────────────────────────────

document.getElementById('block-enabled').addEventListener('change', (e) => {
  port.postMessage({ type: 'setBlockEnabled', enabled: e.target.checked });
});

document.querySelectorAll('.bp-preset').forEach((chip) => {
  chip.addEventListener('click', () => togglePreset(chip.dataset.preset));
});

document.getElementById('bp-add-btn').addEventListener('click', () => {
  const input = document.getElementById('bp-add-input');
  if (addCustomSite(input.value)) input.value = '';
});

document.getElementById('bp-add-input').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  e.preventDefault();
  const input = e.target;
  if (addCustomSite(input.value)) input.value = '';
});

// ── Timer event wiring ────────────────────────────────────────────────────────

document.getElementById('time-text').addEventListener('click', enterEditMode);

document.getElementById('time-edit').addEventListener('keydown', (e) => {
  if (e.key === 'Enter')  { e.preventDefault(); exitEditMode(true); }
  if (e.key === 'Escape') exitEditMode(false);
});

document.getElementById('time-edit').addEventListener('blur', () => {
  setTimeout(() => { if (isEditing) exitEditMode(true); }, 150);
});

document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () =>
    port.postMessage({ type: 'setMode', mode: tab.dataset.mode }));
});

document.getElementById('start-pause-btn').addEventListener('click', () => {
  if (!state) return;
  port.postMessage({ type: state.isRunning ? 'pause' : 'start' });
});

document.getElementById('reset-btn').addEventListener('click', () =>
  port.postMessage({ type: 'reset' }));

document.getElementById('skip-btn').addEventListener('click', () =>
  port.postMessage({ type: 'skip' }));

document.getElementById('add-min-btn').addEventListener('click', () =>
  port.postMessage({ type: 'addMinute' }));

// ── Boot ──────────────────────────────────────────────────────────────────────

connect();
