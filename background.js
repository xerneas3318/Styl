// Styl — background timer engine + site blocker

const DEFAULTS = {
  mode: 'focus',
  timeRemaining: 25 * 60,
  sessionTotal: 25 * 60,  // denominator for the ring — grows when +1 min is added
  isRunning: false,
  focusDuration: 25 * 60,
  breakDuration: 5 * 60,
  longBreakDuration: 15 * 60,
  sessionsCompleted: 0,
};

let state = { ...DEFAULTS };
let timerInterval = null;
const ports = new Set();

// Block state — persisted separately so it survives timer resets
let blockState = {
  enabled: true,   // master toggle: block sites during focus
  sites: [],       // list of blocked hostnames e.g. ["instagram.com"]
};

// ── Port management ──────────────────────────────────────────────────────────

browser.runtime.onConnect.addListener((port) => {
  ports.add(port);
  // Send both timer and block state immediately on connect
  port.postMessage({ type: 'stateUpdate', state: snapshot() });
  port.postMessage({ type: 'blockStateUpdate', blockState: blockSnapshot() });

  port.onMessage.addListener((msg) => handleMessage(msg, port));
  port.onDisconnect.addListener(() => ports.delete(port));
});

function broadcast(message) {
  ports.forEach((port) => {
    try { port.postMessage(message); }
    catch (_) { ports.delete(port); }
  });
}

function broadcastState(event = null) {
  const msg = { type: 'stateUpdate', state: snapshot() };
  if (event) msg.event = event;
  broadcast(msg);
}

function broadcastBlockState() {
  broadcast({ type: 'blockStateUpdate', blockState: blockSnapshot() });
}

function snapshot()      { return { ...state }; }
function blockSnapshot() { return { enabled: blockState.enabled, sites: [...blockState.sites] }; }

// ── One-shot messages (used by the blocked.html page) ────────────────────────

browser.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'getTimerState') {
    sendResponse({ timeRemaining: state.timeRemaining, mode: state.mode });
    return false;
  }
});

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
  state.sessionTotal = durationFor(state.mode);

  saveSettings();
  playChime();

  browser.notifications.create('styl-timer', {
    type: 'basic',
    iconUrl: browser.runtime.getURL('icons/icon.svg'),
    title: 'Styl',
    message: prevMode === 'focus'
      ? `Time for a ${state.mode === 'longBreak' ? 'long ' : ''}break!`
      : 'Break over — time to focus.',
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
      state.sessionTotal  = durationFor(state.mode);
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
      state.sessionTotal  = durationFor(state.mode);
      broadcastState();
      break;

    case 'setMode':
      state.isRunning = false;
      clearInterval(timerInterval);
      timerInterval = null;
      state.mode = msg.mode;
      state.timeRemaining = durationFor(state.mode);
      state.sessionTotal  = durationFor(state.mode);
      broadcastState();
      break;

    case 'updateSettings': {
      const { focusDuration, breakDuration, longBreakDuration } = msg;
      if (focusDuration > 0)     state.focusDuration     = focusDuration;
      if (breakDuration > 0)     state.breakDuration     = breakDuration;
      if (longBreakDuration > 0) state.longBreakDuration = longBreakDuration;
      if (!state.isRunning) {
        state.timeRemaining = durationFor(state.mode);
        state.sessionTotal  = durationFor(state.mode);
      }
      saveSettings();
      broadcastState();
      break;
    }

    case 'addMinute':
      state.timeRemaining += 60;
      state.sessionTotal  += 60;
      broadcastState();
      break;

    case 'getState':
      port.postMessage({ type: 'stateUpdate', state: snapshot() });
      break;

    // ── Block state ──────────────────────────────────────────────────────────

    case 'setBlockEnabled':
      blockState.enabled = !!msg.enabled;
      saveBlockState();
      broadcastBlockState();
      break;

    case 'setBlockedSites':
      blockState.sites = Array.isArray(msg.sites) ? msg.sites : [];
      saveBlockState();
      broadcastBlockState();
      break;

    case 'getBlockState':
      port.postMessage({ type: 'blockStateUpdate', blockState: blockSnapshot() });
      break;
  }
}

// ── Site blocking ─────────────────────────────────────────────────────────────

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    // Only block during an active focus session
    if (!state.isRunning || state.mode !== 'focus') return {};
    if (!blockState.enabled || blockState.sites.length === 0) return {};

    let host;
    try {
      host = new URL(details.url).hostname.replace(/^www\./, '');
    } catch (_) {
      return {};
    }

    const blocked = blockState.sites.some(
      (site) => host === site || host.endsWith('.' + site)
    );

    if (blocked) {
      return {
        redirectUrl:
          browser.runtime.getURL('blocked/blocked.html') +
          '?site=' + encodeURIComponent(host),
      };
    }
    return {};
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['blocking']
);

// ── Persistence ───────────────────────────────────────────────────────────────

function saveSettings() {
  browser.storage.local.set({
    settings: {
      focusDuration:     state.focusDuration,
      breakDuration:     state.breakDuration,
      longBreakDuration: state.longBreakDuration,
      sessionsCompleted: state.sessionsCompleted,
    },
  });
}

function saveBlockState() {
  browser.storage.local.set({ blockState: blockSnapshot() });
}

browser.storage.local.get(['settings', 'blockState']).then((result) => {
  if (result.settings) {
    const s = result.settings;
    if (s.focusDuration)     state.focusDuration     = s.focusDuration;
    if (s.breakDuration)     state.breakDuration     = s.breakDuration;
    if (s.longBreakDuration) state.longBreakDuration = s.longBreakDuration;
    if (s.sessionsCompleted) state.sessionsCompleted = s.sessionsCompleted;
    state.timeRemaining = durationFor(state.mode);
    state.sessionTotal  = durationFor(state.mode);
  }
  if (result.blockState) {
    if (typeof result.blockState.enabled === 'boolean') {
      blockState.enabled = result.blockState.enabled;
    }
    if (Array.isArray(result.blockState.sites)) {
      blockState.sites = result.blockState.sites;
    }
  }
});
