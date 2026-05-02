import { Storage } from '../shared/storage';
import type { AppState, AppSettings, TimerMode, BlockGate, BlockPresets, BgMessage, AnnoyingLevel } from '../shared/types';

import {
  defaultTimerState, getTimeRemaining,
  startTimer, pauseTimer, resetTimer, skipTimer,
  setTimerMode, addMinute, onTimerComplete,
  ALARM_COMPLETE, ALARM_KEEPALIVE,
} from './timer';

// Detect browser at runtime.
// The Chrome build banner sets `browser = chrome`, so getURL starts with chrome-extension://.
const IS_FIREFOX = browser.runtime.getURL('').startsWith('moz-extension://');

const DEFAULT_PRESETS: BlockPresets = {
  social: ['instagram.com','facebook.com','twitter.com','x.com','tiktok.com',
           'reddit.com','snapchat.com','pinterest.com','threads.net','linkedin.com','tumblr.com'],
  video:  ['youtube.com','netflix.com','twitch.tv','hulu.com','disneyplus.com','primevideo.com','vimeo.com'],
  news:   ['cnn.com','bbc.com','nytimes.com','buzzfeed.com','theguardian.com','huffpost.com','dailymail.co.uk'],
};

let appState: AppState = {
  timer:      defaultTimerState(),
  blockState: {
    enabled: true, alwaysSites: [], focusSites: [],
    gate: 'none', bypassPassword: '',
    presets: { ...DEFAULT_PRESETS },
  },
};

let settings: AppSettings = {
  focusDuration:     25 * 60,
  breakDuration:     5  * 60,
  longBreakDuration: 15 * 60,
  theme:             'dark',
  fontSize:          'medium',
  apiKey:            '',
  timerSound:        true,
  annoyingLevel:     'off',
  reminders:         false,
};

// Per-site temporary bypass: site → expiry timestamp (ms)
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

    // Migrate old single-sites format
    if (!bs.alwaysSites && !bs.focusSites) {
      appState.blockState.focusSites  = (bs.sites as string[] | undefined) ?? [];
      appState.blockState.alwaysSites = [];
    }
    if (!appState.blockState.alwaysSites) appState.blockState.alwaysSites = [];
    if (!appState.blockState.focusSites)  appState.blockState.focusSites  = [];
    if (!appState.blockState.gate)                        appState.blockState.gate = 'none';
    if (appState.blockState.bypassPassword === undefined) appState.blockState.bypassPassword = '';
    if (!appState.blockState.presets) appState.blockState.presets = { ...DEFAULT_PRESETS };

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
  updateBadge();
  syncReminderAlarm(); // restore reminder alarm if running focus with reminders on
  await syncDnrRules(); // Chrome: restore rules after service worker restart
})();

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === ALARM_COMPLETE) {
    const { state, prevMode } = onTimerComplete(appState.timer);
    appState.timer = state;
    browser.alarms.clear(ALARM_REMINDER); // focus ended, no more reminders

    if (settings.timerSound) {
      browser.notifications.create('styl-done', {
        type:     'basic',
        iconUrl:  browser.runtime.getURL('icons/icon.svg'),
        title:    'Styl',
        message:  prevMode === 'focus'
          ? `Time for a ${state.mode === 'longBreak' ? 'long ' : ''}break!`
          : 'Break over — back to focus.',
      });
    }

    persistState();
    broadcast({ type: 'stateUpdate', state: appState, event: 'timerComplete' });
    updateBadge();
    syncDnrRules(); // focus timer ended — remove focus-site rules on Chrome
  }

  if (alarm.name === ALARM_REMINDER) {
    if (appState.timer.isRunning && appState.timer.mode === 'focus') {
      browser.notifications.create('styl-reminder', {
        type:    'basic',
        iconUrl: browser.runtime.getURL('icons/icon.svg'),
        title:   'Time to check in',
        message: 'You\'ve been focusing for a while — still going, or time for a break?',
      });
    } else {
      browser.alarms.clear(ALARM_REMINDER);
    }
  }

  if (alarm.name === ALARM_BADGE_TICK) {
    updateBadge();
  }

  if (alarm.name === ALARM_KEEPALIVE && appState.timer.isRunning) {
    broadcast({ type: 'stateUpdate', state: appState });
    updateBadge();
  }
});

browser.notifications.onClicked.addListener((id) => {
  if (id === 'styl-reminder') {
    browser.action.openPopup().catch(() => {});
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
  updateBadge();
}

// ── Badge ────────────────────────────────────────────────────────────────────

const ALARM_BADGE_TICK = 'styl-badge-tick';

function updateBadge(): void {
  browser.alarms.clear(ALARM_BADGE_TICK);
  if (!appState.timer.isRunning) {
    browser.action.setBadgeText({ text: '' });
    return;
  }
  const secs = Math.max(0, getTimeRemaining(appState.timer));
  const mins = Math.ceil(secs / 60);
  browser.action.setBadgeText({ text: String(mins) });
  browser.action.setBadgeBackgroundColor({ color: '#ffffff' });
  browser.action.setBadgeTextColor({ color: '#000000' });
  // Schedule next update at the exact moment the minute count flips.
  // Chrome MV3 clamps alarm delays to ≥1 min, so badge ticks are less precise
  // there; Firefox honours sub-minute delays and flips exactly on time.
  if (secs > 0) {
    const secsUntilFlip = (secs % 60) || 60;
    browser.alarms.create(ALARM_BADGE_TICK, { delayInMinutes: secsUntilFlip / 60 });
  }
}

// ── Reminder alarm ───────────────────────────────────────────────────────────

const ALARM_REMINDER = 'styl-reminder';

// Create or clear the reminder alarm based on current state.
// Only fires during active focus sessions with reminders enabled.
function syncReminderAlarm(): void {
  if (settings.reminders && appState.timer.isRunning && appState.timer.mode === 'focus') {
    browser.alarms.get(ALARM_REMINDER).then((alarm) => {
      if (!alarm) {
        browser.alarms.create(ALARM_REMINDER, { delayInMinutes: 5, periodInMinutes: 5 });
      }
    });
  } else {
    browser.alarms.clear(ALARM_REMINDER);
  }
}

// ── Chrome: declarativeNetRequest blocking ───────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const getDnr = (): any => (globalThis as any).chrome?.declarativeNetRequest;

async function syncDnrRules(): Promise<void> {
  if (IS_FIREFOX) return;
  const dnr = getDnr();
  if (!dnr) return;

  const existing: Array<{ id: number }> = await dnr.getDynamicRules();
  const removeIds = existing.map((r) => r.id);

  const rules: object[] = [];
  let id = 1;
  const blockedUrl = browser.runtime.getURL('blocked/blocked.html');
  const { enabled, alwaysSites, focusSites, gate } = appState.blockState;

  if (enabled) {
    const now = Date.now();
    for (const site of alwaysSites) {
      const exp = tempBypass.get(site);
      if (exp !== undefined && now < exp) continue;
      rules.push(makeDnrRule(id++, site, 'always', gate, blockedUrl, settings.annoyingLevel));
    }
    if (appState.timer.isRunning && appState.timer.mode === 'focus') {
      for (const site of focusSites) {
        const exp = tempBypass.get(site);
        if (exp !== undefined && now < exp) continue;
        rules.push(makeDnrRule(id++, site, 'focus', gate, blockedUrl, settings.annoyingLevel));
      }
    }
  }

  await dnr.updateDynamicRules({ removeRuleIds: removeIds, addRules: rules });
}

function makeDnrRule(
  id: number, site: string, bm: 'always' | 'focus', gate: string, blockedUrl: string, annoyingLevel: AnnoyingLevel,
): object {
  const annoyingParam = annoyingLevel !== 'off' ? `&annoying=${annoyingLevel}` : '';
  return {
    id,
    priority: 1,
    action: {
      type: 'redirect',
      redirect: {
        url: `${blockedUrl}?site=${encodeURIComponent(site)}&gate=${encodeURIComponent(gate)}&bm=${bm}${annoyingParam}`,
      },
    },
    condition: {
      urlFilter: `||${site}^`,
      resourceTypes: ['main_frame'],
    },
  };
}

// ── One-shot messages (used by blocked page) ─────────────────────────────────

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
      const site = msg.site;
      if (site) {
        tempBypass.set(site, Date.now() + 5000);
        if (!IS_FIREFOX) {
          // Remove the DNR rule before responding so the navigation that follows
          // the response doesn't race against the rule still being in place.
          syncDnrRules().then(() => {
            sendResponse({ ok: true });
            setTimeout(() => {
              tempBypass.delete(site);
              syncDnrRules();
            }, 5000);
          });
          return true; // async sendResponse
        }
      }
      sendResponse({ ok: true });
      return false;
    }
    return false;
  }
);

// ── Message handler ──────────────────────────────────────────────────────────

async function handleMessage(msg: BgMessage, _port: browser.runtime.Port): Promise<void> {
  switch (msg.type) {
    case 'timerStart':
      appState.timer = startTimer(appState.timer);
      await persistState(); broadcastState();
      await syncDnrRules(); // add focus-site rules on Chrome
      redirectBlockedTabs();
      syncReminderAlarm();
      break;

    case 'timerPause':
      appState.timer = pauseTimer(appState.timer);
      await persistState(); broadcastState();
      syncDnrRules(); // focus sites no longer active on Chrome
      syncReminderAlarm();
      break;

    case 'timerReset':
      appState.timer = resetTimer(appState.timer);
      await persistState(); broadcastState();
      syncDnrRules();
      syncReminderAlarm();
      break;

    case 'timerSkip':
      appState.timer = skipTimer(appState.timer);
      await persistState(); broadcastState();
      syncDnrRules(); // mode may have changed
      syncReminderAlarm();
      break;

    case 'timerSetMode':
      appState.timer = setTimerMode(appState.timer, msg.mode as TimerMode);
      await persistState(); broadcastState();
      syncDnrRules();
      syncReminderAlarm();
      break;

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
      await syncDnrRules();
      if (msg.enabled) redirectBlockedTabs();
      else             unblockFreedTabs();
      break;

    case 'setAlwaysSites':
      appState.blockState.alwaysSites = msg.sites;
      await persistState();
      broadcast({ type: 'blockStateUpdate', blockState: { ...appState.blockState } });
      await syncDnrRules();
      redirectBlockedTabs();
      unblockFreedTabs();
      break;

    case 'setFocusSites':
      appState.blockState.focusSites = msg.sites;
      await persistState();
      broadcast({ type: 'blockStateUpdate', blockState: { ...appState.blockState } });
      await syncDnrRules();
      unblockFreedTabs();
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
      syncDnrRules(); // gate param in redirect URL changed
      break;

    case 'setPresets':
      appState.blockState.presets = msg.presets as BlockPresets;
      await persistState();
      broadcast({ type: 'blockStateUpdate', blockState: { ...appState.blockState } });
      break;

    case 'setTimerSound':
      settings.timerSound = msg.enabled;
      await Storage.setSettings(settings);
      break;

    case 'setAnnoyingLevel':
      settings.annoyingLevel = msg.level;
      await Storage.setSettings(settings);
      await syncDnrRules(); // update Chrome DNR redirect URLs
      break;

    case 'setReminders':
      settings.reminders = msg.enabled;
      await Storage.setSettings(settings);
      syncReminderAlarm();
      break;
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

// Check if a host is permanently blocked (ignores tempBypass — used for unblock decisions).
function isPermBlocked(host: string): boolean {
  const { enabled, alwaysSites, focusSites } = appState.blockState;
  if (!enabled) return false;
  if (alwaysSites.some((s) => host === s || host.endsWith('.' + s))) return true;
  if (appState.timer.isRunning && appState.timer.mode === 'focus') {
    return focusSites.some((s) => host === s || host.endsWith('.' + s));
  }
  return false;
}

// For webRequest (Firefox only): also checks tempBypass.
function getBlockInfo(host: string): { bm: 'always' | 'focus' } | null {
  const { enabled, alwaysSites, focusSites } = appState.blockState;
  if (!enabled) return null;

  const exp = tempBypass.get(host);
  if (exp !== undefined) {
    if (Date.now() < exp) return null;
    tempBypass.delete(host);
  }

  if (alwaysSites.some((s) => host === s || host.endsWith('.' + s))) {
    return { bm: 'always' };
  }
  if (appState.timer.isRunning && appState.timer.mode === 'focus') {
    if (focusSites.some((s) => host === s || host.endsWith('.' + s))) {
      return { bm: 'focus' };
    }
  }
  return null;
}

// Redirect currently-open tabs to the blocked page when sites become blocked.
async function redirectBlockedTabs(): Promise<void> {
  if (!appState.blockState.enabled) return;
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
        + '&bm='   + info.bm
        + (settings.annoyingLevel !== 'off' ? `&annoying=${settings.annoyingLevel}` : '');
      browser.tabs.update(tab.id, { url: blockedUrl }).catch(() => {});
    }
  }
}

// Navigate blocked-page tabs back when a site is unblocked.
async function unblockFreedTabs(): Promise<void> {
  const blockedBase = browser.runtime.getURL('blocked/blocked.html');
  const tabs = await browser.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !tab.id) continue;
    if (!tab.url.startsWith(blockedBase)) continue;

    let params: URLSearchParams;
    try { params = new URL(tab.url).searchParams; }
    catch { continue; }

    const site = params.get('site');
    // `from` may be absent on Chrome (DNR redirects don't carry it); fall back to site root.
    const from = params.get('from') || (site ? 'https://' + site : null);
    if (!site || !from) continue;

    if (!isPermBlocked(site)) {
      browser.tabs.update(tab.id, { url: from }).catch(() => {});
    }
  }
}

async function persistState(): Promise<void> {
  await Storage.setState(appState);
}

// ── Firefox: webRequest blocking ─────────────────────────────────────────────
// Chrome MV3 does not support blocking webRequest; it uses declarativeNetRequest
// rules managed by syncDnrRules() above instead.

if (IS_FIREFOX) {
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
          '&bm='   + info.bm +
          (settings.annoyingLevel !== 'off' ? `&annoying=${settings.annoyingLevel}` : ''),
      };
    },
    { urls: ['<all_urls>'], types: ['main_frame'] },
    ['blocking']
  );
}
