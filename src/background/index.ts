import { Storage } from '../shared/storage';
import type { AppState, AppSettings, TimerMode, BlockGate, BgMessage } from '../shared/types';

import {
  defaultTimerState, getTimeRemaining,
  startTimer, pauseTimer, resetTimer, skipTimer,
  setTimerMode, addMinute, onTimerComplete,
  ALARM_COMPLETE, ALARM_KEEPALIVE,
} from './timer';

let appState: AppState = {
  timer:      defaultTimerState(),
  blockState: { enabled: true, alwaysSites: [], focusSites: [], gate: 'none', bypassPassword: '' },
};

let settings: AppSettings = {
  focusDuration:     25 * 60,
  breakDuration:     5  * 60,
  longBreakDuration: 15 * 60,
};

// Temporary per-site bypass: site → expiry timestamp (ms)
// Set when the user successfully passes the gate; allows one navigation through.
const tempBypass = new Map<string, number>();

const ports = new Set<browser.runtime.Port>();

(async function boot() {
  const [savedState, savedSettings] = await Promise.all([
    Storage.getState(),
    Storage.getSettings(),
  ]);

  if (savedState) {
    appState = savedState as AppState;
    const bs = appState.blockState as Record<string, unknown>;

    // Migrate old format that had a single `sites` array
    if (!bs.alwaysSites && !bs.focusSites) {
      appState.blockState.focusSites  = (bs.sites as string[] | undefined) ?? [];
      appState.blockState.alwaysSites = [];
    }
    if (!appState.blockState.alwaysSites) appState.blockState.alwaysSites = [];
    if (!appState.blockState.focusSites)  appState.blockState.focusSites  = [];
    if (!appState.blockState.gate)                        appState.blockState.gate = 'none';
    if (appState.blockState.bypassPassword === undefined) appState.blockState.bypassPassword = '';

    if (appState.timer.isRunning && appState.timer.startTime !== null) {
      const remaining = getTimeRemaining(appState.timer);
      if (remaining <= 0) {
        const { state } = onTimerComplete(appState.timer);
        appState.timer = state;
      } else {
        browser.alarms.create(ALARM_COMPLETE, { delayInMinutes: remaining / 60 });
      }
    }
  }

  if (savedSettings) settings = savedSettings as AppSettings;

  browser.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 });
})();

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_COMPLETE) {
    const { state, prevMode } = onTimerComplete(appState.timer);
    appState.timer = state;

    browser.notifications.create('styl-done', {
      type:     'basic',
      iconUrl:  browser.runtime.getURL('icons/icon.svg'),
      title:    'Styl',
      message:  prevMode === 'focus'
        ? `Time for a ${state.mode === 'longBreak' ? 'long ' : ''}break!`
        : 'Break over — back to focus.',
    });

    persistState();
    broadcast({ type: 'stateUpdate', state: appState, event: 'timerComplete' });
  }

  if (alarm.name === ALARM_KEEPALIVE && appState.timer.isRunning) {
    broadcast({ type: 'stateUpdate', state: appState });
  }
});

browser.runtime.onConnect.addListener((port) => {
  ports.add(port);
  port.postMessage({ type: 'stateUpdate', state: appState });
  port.onMessage.addListener((msg: BgMessage) => handleMessage(msg, port));
  port.onDisconnect.addListener(() => ports.delete(port));
});

function broadcast(msg: unknown): void {
  for (const p of ports) {
    try   { p.postMessage(msg); }
    catch { ports.delete(p);   }
  }
}

function broadcastState(): void {
  broadcast({ type: 'stateUpdate', state: appState });
}

// One-shot messages (used by blocked page)
browser.runtime.onMessage.addListener(
  (msg: { type: string; password?: string; site?: string }, _sender, sendResponse: (r: unknown) => void) => {
    if (msg.type === 'getTimerState') {
      sendResponse({ timeRemaining: getTimeRemaining(appState.timer), mode: appState.timer.mode });
      return false;
    }
    if (msg.type === 'getBlockState') {
      sendResponse({ blockState: appState.blockState });
      return false;
    }
    if (msg.type === 'checkBypassPassword') {
      const pw = appState.blockState.bypassPassword;
      sendResponse({ allowed: pw !== '' && msg.password === pw });
      return false;
    }
    if (msg.type === 'requestBypass') {
      // Grant a 5-second window for the bypassed site to load without being intercepted
      if (msg.site) tempBypass.set(msg.site, Date.now() + 5000);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  }
);

async function handleMessage(msg: BgMessage, _port: browser.runtime.Port): Promise<void> {
  switch (msg.type) {
    case 'timerStart':
      appState.timer = startTimer(appState.timer);
      await persistState(); broadcastState();
      redirectBlockedTabs();
      break;

    case 'timerPause':
      appState.timer = pauseTimer(appState.timer);
      await persistState(); broadcastState(); break;

    case 'timerReset':
      appState.timer = resetTimer(appState.timer);
      await persistState(); broadcastState(); break;

    case 'timerSkip':
      appState.timer = skipTimer(appState.timer);
      await persistState(); broadcastState(); break;

    case 'timerSetMode':
      appState.timer = setTimerMode(appState.timer, msg.mode as TimerMode);
      await persistState(); broadcastState(); break;

    case 'timerAddMinute':
      appState.timer = addMinute(appState.timer);
      await persistState(); broadcastState(); break;

    case 'timerUpdateSettings': {
      const t = appState.timer;
      if (msg.focusDuration)     appState.timer = { ...t, focusDuration:     msg.focusDuration };
      if (msg.breakDuration)     appState.timer = { ...appState.timer, breakDuration:     msg.breakDuration };
      if (msg.longBreakDuration) appState.timer = { ...appState.timer, longBreakDuration: msg.longBreakDuration };
      if (!t.isRunning) appState.timer = resetTimer(appState.timer);
      await persistState(); broadcastState(); break;
    }

    case 'setBlockEnabled':
      appState.blockState.enabled = msg.enabled;
      await persistState();
      broadcast({ type: 'blockStateUpdate', blockState: { ...appState.blockState } });
      if (msg.enabled) redirectBlockedTabs();
      break;

    case 'setAlwaysSites':
      appState.blockState.alwaysSites = msg.sites;
      await persistState();
      broadcast({ type: 'blockStateUpdate', blockState: { ...appState.blockState } });
      redirectBlockedTabs();
      break;

    case 'setFocusSites':
      appState.blockState.focusSites = msg.sites;
      await persistState();
      broadcast({ type: 'blockStateUpdate', blockState: { ...appState.blockState } });
      break;

    case 'setBlockGate':
      appState.blockState.gate = msg.gate as BlockGate;
      if (msg.gate === 'password' && msg.password !== undefined) {
        appState.blockState.bypassPassword = msg.password;
      } else if (msg.gate !== 'password') {
        appState.blockState.bypassPassword = '';
      }
      await persistState();
      broadcast({ type: 'blockStateUpdate', blockState: { ...appState.blockState } });
      break;
  }
}

// Returns whether the given host should be blocked right now,
// and if so, which mode ('always' | 'focus') — used to inform the blocked page.
function getBlockInfo(host: string): { blocked: boolean; bm: 'always' | 'focus' } | null {
  const { enabled, alwaysSites, focusSites } = appState.blockState;
  if (!enabled) return null;

  // Check temporary bypass first
  const exp = tempBypass.get(host);
  if (exp !== undefined) {
    if (Date.now() < exp) return null; // bypass still valid
    tempBypass.delete(host);
  }

  if (alwaysSites.some((s) => host === s || host.endsWith('.' + s))) {
    return { blocked: true, bm: 'always' };
  }
  if (appState.timer.isRunning && appState.timer.mode === 'focus') {
    if (focusSites.some((s) => host === s || host.endsWith('.' + s))) {
      return { blocked: true, bm: 'focus' };
    }
  }
  return null;
}

async function redirectBlockedTabs(): Promise<void> {
  const { enabled } = appState.blockState;
  if (!enabled) return;
  const { gate } = appState.blockState;

  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    if (tab.url.startsWith('moz-extension://') || tab.url.startsWith('chrome-extension://')) continue;
    let host: string;
    try { host = new URL(tab.url).hostname.replace(/^www\./, ''); }
    catch { continue; }
    const info = getBlockInfo(host);
    if (info) {
      const blockedUrl = browser.runtime.getURL('blocked/blocked.html')
        + '?site=' + encodeURIComponent(host)
        + '&from=' + encodeURIComponent(tab.url)
        + '&gate=' + gate
        + '&bm='   + info.bm;
      browser.tabs.update(tab.id, { url: blockedUrl }).catch(() => {});
    }
  }
}

async function persistState(): Promise<void> {
  await Storage.setState(appState);
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    let host: string;
    try { host = new URL(details.url).hostname.replace(/^www\./, ''); }
    catch { return {}; }

    const info = getBlockInfo(host);
    if (!info) return {};

    const { gate } = appState.blockState;
    return {
      redirectUrl:
        browser.runtime.getURL('blocked/blocked.html') +
        '?site=' + encodeURIComponent(host) +
        '&from=' + encodeURIComponent(details.url) +
        '&gate=' + gate +
        '&bm='   + info.bm,
    };
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['blocking']
);
