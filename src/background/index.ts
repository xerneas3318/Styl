import { Storage } from '../shared/storage';
import type { AppState, AppSettings, TimerMode, BgMessage } from '../shared/types';

import {
  defaultTimerState, getTimeRemaining,
  startTimer, pauseTimer, resetTimer, skipTimer,
  setTimerMode, addMinute, onTimerComplete,
  ALARM_COMPLETE, ALARM_KEEPALIVE,
} from './timer';

let appState: AppState = {
  timer:      defaultTimerState(),
  blockState: { enabled: true, sites: [] },
};

let settings: AppSettings = {
  focusDuration:     25 * 60,
  breakDuration:     5  * 60,
  longBreakDuration: 15 * 60,
};

const ports = new Set<browser.runtime.Port>();

(async function boot() {
  const [savedState, savedSettings] = await Promise.all([
    Storage.getState(),
    Storage.getSettings(),
  ]);

  if (savedState) {
    appState = savedState as AppState;
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

browser.runtime.onMessage.addListener(
  (msg: { type: string }, _sender, sendResponse: (r: unknown) => void) => {
    if (msg.type === 'getTimerState') {
      sendResponse({ timeRemaining: getTimeRemaining(appState.timer), mode: appState.timer.mode });
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
      break;

    case 'setBlockedSites':
      appState.blockState.sites = msg.sites;
      await persistState();
      broadcast({ type: 'blockStateUpdate', blockState: { ...appState.blockState } });
      break;
  }
}

async function redirectBlockedTabs(): Promise<void> {
  const { enabled, sites } = appState.blockState;
  if (!enabled || !sites.length) return;
  if (!appState.timer.isRunning || appState.timer.mode !== 'focus') return;

  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    if (tab.url.startsWith('moz-extension://') || tab.url.startsWith('chrome-extension://')) continue;
    let host: string;
    try { host = new URL(tab.url).hostname.replace(/^www\./, ''); }
    catch { continue; }
    const isBlocked = sites.some((s) => host === s || host.endsWith('.' + s));
    if (isBlocked) {
      browser.tabs.update(tab.id, {
        url: browser.runtime.getURL('blocked/blocked.html') + '?site=' + encodeURIComponent(host),
      }).catch(() => {});
    }
  }
}

async function persistState(): Promise<void> {
  await Storage.setState(appState);
}

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const { enabled, sites } = appState.blockState;
    if (!enabled || !sites.length) return {};
    if (!appState.timer.isRunning || appState.timer.mode !== 'focus') return {};

    let host: string;
    try { host = new URL(details.url).hostname.replace(/^www\./, ''); }
    catch { return {}; }

    const blocked = sites.some((s) => host === s || host.endsWith('.' + s));
    if (!blocked) return {};

    return {
      redirectUrl:
        browser.runtime.getURL('blocked/blocked.html') +
        '?site=' + encodeURIComponent(host),
    };
  },
  { urls: ['<all_urls>'], types: ['main_frame'] },
  ['blocking']
);
