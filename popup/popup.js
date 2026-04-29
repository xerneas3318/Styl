// Styl popup controller

const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // r=52 ≈ 326.73

const PRESETS = {
  focus:     [15, 20, 25, 30, 45, 60, 90],
  break:     [5, 10, 15],
  longBreak: [10, 15, 20, 25, 30],
};

let port      = null;
let state     = null;
let isEditing = false;

// ── Connection ────────────────────────────────────────────────────────────────

function connect() {
  port = browser.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((msg) => {
    if (msg.type !== 'stateUpdate') return;
    state = msg.state;
    render();
    if (msg.event === 'timerComplete') playChime();
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 300));
}

// ── Rendering ─────────────────────────────────────────────────────────────────

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

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.mode === state.mode));

  // Timer text — freeze during edit so typing isn't overwritten
  if (!isEditing) {
    document.getElementById('time-text').textContent = fmt(state.timeRemaining);
  }

  // Progress ring
  const total    = totalFor(state.mode);
  const progress = state.timeRemaining / total;
  const offset   = (1 - progress) * RING_CIRCUMFERENCE;
  const ring     = document.getElementById('progress-ring');
  ring.style.strokeDashoffset = offset;
  ring.className = 'ring-fg' +
    (state.mode === 'break'     ? ' break-mode' :
     state.mode === 'longBreak' ? ' long-mode'  : '');

  // Start/Pause label
  document.getElementById('start-pause-btn').textContent =
    state.isRunning ? 'Pause' : 'Start';

  // Session dots
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

// ── Edit mode ─────────────────────────────────────────────────────────────────

function enterEditMode() {
  if (isEditing) return;
  isEditing = true;

  // Pause if running so the timer doesn't race against editing
  if (state?.isRunning) port.postMessage({ type: 'pause' });

  const mode    = state?.mode || 'focus';
  const minutes = Math.round(totalFor(mode) / 60);

  // Swap display → input
  document.getElementById('time-text').classList.add('hidden');
  document.getElementById('time-editor').classList.remove('hidden');
  const input = document.getElementById('time-edit');
  input.value = minutes;
  input.focus();
  input.select();

  // Show mode-appropriate presets, highlight the current value
  buildPresets(mode, minutes);
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

function buildPresets(mode, currentMinutes) {
  const bar = document.getElementById('preset-bar');
  bar.innerHTML = '';
  (PRESETS[mode] || PRESETS.focus).forEach((val) => {
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (val === currentMinutes ? ' active' : '');
    chip.textContent = `${val}m`;
    // mousedown fires before blur, so preventDefault keeps focus on the input
    // long enough for the click handler to read the value
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', () => applyPreset(val));
    bar.appendChild(chip);
  });
}

function applyPreset(val) {
  document.getElementById('time-edit').value = val;
  exitEditMode(true);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('time-text').addEventListener('click', enterEditMode);

document.getElementById('time-edit').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); exitEditMode(true); }
  if (e.key === 'Escape') exitEditMode(false);
});

// Save on click-away; delay so preset chip's click fires first
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

// ── Boot ──────────────────────────────────────────────────────────────────────

connect();
