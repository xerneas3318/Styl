// Moments — background timer engine
// Manages all timer state and broadcasts updates to connected pages via ports.

const DEFAULTS = {
  mode: 'focus',           // 'focus' | 'break' | 'longBreak'
  timeRemaining: 25 * 60,
  isRunning: false,
  focusDuration: 25 * 60,
  breakDuration: 5 * 60,
  longBreakDuration: 15 * 60,
  sessionsCompleted: 0,
};

let state = { ...DEFAULTS };
let timerInterval = null;
const ports = new Set();

// ── Port management ──────────────────────────────────────────────────────────

browser.runtime.onConnect.addListener((port) => {
  ports.add(port);
  port.postMessage({ type: 'stateUpdate', state: snapshot() });

  port.onMessage.addListener((msg) => handleMessage(msg, port));

  port.onDisconnect.addListener(() => {
    ports.delete(port);
  });
});

function broadcast(message) {
  ports.forEach((port) => {
    try {
      port.postMessage(message);
    } catch (_) {
      ports.delete(port);
    }
  });
}

function broadcastState(event = null) {
  const msg = { type: 'stateUpdate', state: snapshot() };
  if (event) msg.event = event;
  broadcast(msg);
}

function snapshot() {
  return { ...state };
}

// ── Timer logic ───────────────────────────────────────────────────────────────

function tick() {
  if (state.timeRemaining > 0) {
    state.timeRemaining--;
    broadcastState();
  } else {
    onTimerComplete();
  }
}

function onTimerComplete() {
  clearInterval(timerInterval);
  timerInterval = null;
  state.isRunning = false;

  const prevMode = state.mode;

  if (state.mode === 'focus') {
    state.sessionsCompleted++;
    state.mode = state.sessionsCompleted % 4 === 0 ? 'longBreak' : 'break';
    state.timeRemaining = durationFor(state.mode);
  } else {
    state.mode = 'focus';
    state.timeRemaining = durationFor('focus');
  }

  saveSettings();

  const message = prevMode === 'focus'
    ? `Time for a ${state.mode === 'longBreak' ? 'long ' : ''}break!`
    : 'Break over — time to focus.';

  // Play from the persistent background page — always running, no autoplay block
  playChime();

  browser.notifications.create('moments-timer', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon.svg'),
    title: 'Moments',
    message,
  });

  broadcastState('timerComplete');
}

function durationFor(mode) {
  switch (mode) {
    case 'focus':     return state.focusDuration;
    case 'break':     return state.breakDuration;
    case 'longBreak': return state.longBreakDuration;
    default:          return state.focusDuration;
  }
}

// ── Message handlers ──────────────────────────────────────────────────────────

function handleMessage(msg, port) {
  switch (msg.type) {
    case 'start':
      if (!state.isRunning && state.timeRemaining > 0) {
        state.isRunning = true;
        timerInterval = setInterval(tick, 1000);
        broadcastState();
      }
      break;

    case 'pause':
      if (state.isRunning) {
        state.isRunning = false;
        clearInterval(timerInterval);
        timerInterval = null;
        broadcastState();
      }
      break;

    case 'reset':
      state.isRunning = false;
      clearInterval(timerInterval);
      timerInterval = null;
      state.timeRemaining = durationFor(state.mode);
      broadcastState();
      break;

    case 'skip':
      state.isRunning = false;
      clearInterval(timerInterval);
      timerInterval = null;
      if (state.mode === 'focus') {
        state.sessionsCompleted++;
        state.mode = state.sessionsCompleted % 4 === 0 ? 'longBreak' : 'break';
      } else {
        state.mode = 'focus';
      }
      state.timeRemaining = durationFor(state.mode);
      broadcastState();
      break;

    case 'setMode':
      state.isRunning = false;
      clearInterval(timerInterval);
      timerInterval = null;
      state.mode = msg.mode;
      state.timeRemaining = durationFor(state.mode);
      broadcastState();
      break;

    case 'updateSettings': {
      const { focusDuration, breakDuration, longBreakDuration } = msg;
      if (focusDuration > 0)     state.focusDuration = focusDuration;
      if (breakDuration > 0)     state.breakDuration = breakDuration;
      if (longBreakDuration > 0) state.longBreakDuration = longBreakDuration;
      if (!state.isRunning) {
        state.timeRemaining = durationFor(state.mode);
      }
      saveSettings();
      broadcastState();
      break;
    }

    case 'getState':
      port.postMessage({ type: 'stateUpdate', state: snapshot() });
      break;
  }
}

// ── Settings persistence ──────────────────────────────────────────────────────

function saveSettings() {
  browser.storage.local.set({
    settings: {
      focusDuration:    state.focusDuration,
      breakDuration:    state.breakDuration,
      longBreakDuration: state.longBreakDuration,
      sessionsCompleted: state.sessionsCompleted,
    },
  });
}

browser.storage.local.get('settings').then((result) => {
  if (result.settings) {
    const s = result.settings;
    if (s.focusDuration)     state.focusDuration     = s.focusDuration;
    if (s.breakDuration)     state.breakDuration     = s.breakDuration;
    if (s.longBreakDuration) state.longBreakDuration = s.longBreakDuration;
    if (s.sessionsCompleted) state.sessionsCompleted = s.sessionsCompleted;
    state.timeRemaining = durationFor(state.mode);
  }
});
