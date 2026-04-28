// Moments popup controller
// Connects to the background via a long-lived port for real-time state updates.

const RING_CIRCUMFERENCE = 2 * Math.PI * 52; // r=52, ≈326.73

let port = null;
let state = null;

// ── Connection ────────────────────────────────────────────────────────────────

function connect() {
  port = browser.runtime.connect({ name: 'popup' });

  port.onMessage.addListener((msg) => {
    if (msg.type !== 'stateUpdate') return;
    state = msg.state;
    render();
    if (msg.event === 'timerComplete') {
      playChime();
    }
  });

  port.onDisconnect.addListener(() => {
    setTimeout(connect, 300);
  });
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
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mode === state.mode);
  });

  // Timer display
  document.getElementById('timer-display').textContent = fmt(state.timeRemaining);

  // Progress ring
  const total    = totalFor(state.mode);
  const progress = state.timeRemaining / total;
  const offset   = (1 - progress) * RING_CIRCUMFERENCE;
  const ring     = document.getElementById('progress-ring');
  ring.style.strokeDashoffset = offset;
  ring.className = 'ring-fg' + (
    state.mode === 'break'     ? ' break-mode' :
    state.mode === 'longBreak' ? ' long-mode'  : ''
  );

  // Start/Pause label
  document.getElementById('start-pause-btn').textContent =
    state.isRunning ? 'Pause' : 'Start';

  // Sessions dots (show last 4 in current cycle)
  const dots = document.getElementById('sessions-dots');
  dots.innerHTML = '';
  const cyclePos = state.sessionsCompleted % 4;
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement('div');
    dot.className = 'session-dot' + (i < cyclePos ? ' filled' : '');
    dots.appendChild(dot);
  }

  // Sessions label
  document.getElementById('sessions-label').textContent =
    `${state.sessionsCompleted} session${state.sessionsCompleted !== 1 ? 's' : ''} completed`;

  // Settings inputs (only when panel is visible to avoid overwriting mid-edit)
  if (!document.getElementById('settings-panel').classList.contains('open')) {
    document.getElementById('focus-input').value      = state.focusDuration     / 60;
    document.getElementById('break-input').value      = state.breakDuration     / 60;
    document.getElementById('long-break-input').value = state.longBreakDuration / 60;
  }
}

// ── Event listeners ───────────────────────────────────────────────────────────

document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    port.postMessage({ type: 'setMode', mode: tab.dataset.mode });
  });
});

document.getElementById('start-pause-btn').addEventListener('click', () => {
  if (!state) return;
  port.postMessage({ type: state.isRunning ? 'pause' : 'start' });
});

document.getElementById('reset-btn').addEventListener('click', () => {
  port.postMessage({ type: 'reset' });
});

document.getElementById('skip-btn').addEventListener('click', () => {
  port.postMessage({ type: 'skip' });
});

document.getElementById('settings-toggle').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('open');
});

document.getElementById('save-btn').addEventListener('click', () => {
  const focusDuration     = parseInt(document.getElementById('focus-input').value, 10)      * 60;
  const breakDuration     = parseInt(document.getElementById('break-input').value, 10)      * 60;
  const longBreakDuration = parseInt(document.getElementById('long-break-input').value, 10) * 60;

  if (focusDuration > 0 && breakDuration > 0 && longBreakDuration > 0) {
    port.postMessage({ type: 'updateSettings', focusDuration, breakDuration, longBreakDuration });
    document.getElementById('settings-panel').classList.remove('open');
  }
});

// ── Boot ──────────────────────────────────────────────────────────────────────

connect();
