import { Storage } from '../shared/storage';
import { isoNow, generateId, clone } from '../shared/utils';
import type { AppState, AppSettings, Task, Memory, TimerMode, AIResponse, BgMessage } from '../shared/types';

import {
  defaultTimerState, getTimeRemaining,
  startTimer, pauseTimer, resetTimer, skipTimer,
  setTimerMode, addMinute, onTimerComplete,
  ALARM_COMPLETE, ALARM_KEEPALIVE,
} from './timer';
import { GitHubClient }                      from './github';
import { AIClient, applyActions }            from './ai';
import { commitChange, computeDiff, createSnapshot } from './version-control';
import { GmailClient }                       from './gmail';
import { CalendarClient }                    from './calendar';

// ── State ─────────────────────────────────────────────────────────────────────

let appState: AppState = {
  tasks:         [],
  memory:        defaultMemory(),
  calendarCache: [],
  timer:         defaultTimerState(),
  blockState:    { enabled: true, sites: [] },
  lastSyncedAt:  null,
};

let settings: AppSettings = {
  github:            null,
  ai:                null,
  google:            null,
  autoApproveAI:     false,
  focusDuration:     25 * 60,
  breakDuration:     5  * 60,
  longBreakDuration: 15 * 60,
};

const ports = new Set<browser.runtime.Port>();

// ── Boot ──────────────────────────────────────────────────────────────────────

(async function boot() {
  const [savedState, savedSettings] = await Promise.all([
    Storage.getState(),
    Storage.getSettings(),
  ]);

  if (savedState) {
    appState = savedState;
    // Repair timer if background was killed while running
    if (appState.timer.isRunning && appState.timer.startTime !== null) {
      const remaining = getTimeRemaining(appState.timer);
      if (remaining <= 0) {
        const { state } = onTimerComplete(appState.timer);
        appState.timer  = state;
      } else {
        // Re-set alarm for the remaining time
        browser.alarms.create(ALARM_COMPLETE, { delayInMinutes: remaining / 60 });
      }
    }
  }

  if (savedSettings) settings = savedSettings;

  // Keep-alive alarm — prevents service worker from sleeping mid-session
  browser.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 });

  if (settings.github) {
    syncFromGitHub().catch((e) => console.warn('[styl] boot sync:', e));
  }
})();

// ── Alarms ────────────────────────────────────────────────────────────────────

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
    broadcast({ type: 'stateUpdate', state: liveState(), event: 'timerComplete' });
  }

  if (alarm.name === ALARM_KEEPALIVE && appState.timer.isRunning) {
    broadcast({ type: 'stateUpdate', state: liveState() });
  }
});

// ── Port management ───────────────────────────────────────────────────────────

browser.runtime.onConnect.addListener((port) => {
  ports.add(port);
  port.postMessage({ type: 'stateUpdate', state: liveState() });
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
  broadcast({ type: 'stateUpdate', state: liveState() });
}

/** State snapshot with live timer value injected. */
function liveState(): AppState {
  return {
    ...appState,
    timer: { ...appState.timer, pausedTimeRemaining: getTimeRemaining(appState.timer) },
  };
}

// ── One-shot messages (for blocked page) ──────────────────────────────────────

browser.runtime.onMessage.addListener(
  (msg: { type: string }, _sender, sendResponse: (r: unknown) => void) => {
    if (msg.type === 'getTimerState') {
      sendResponse({ timeRemaining: getTimeRemaining(appState.timer), mode: appState.timer.mode });
    }
    return false;
  }
);

// ── Message handler ───────────────────────────────────────────────────────────

async function handleMessage(msg: BgMessage, port: browser.runtime.Port): Promise<void> {
  switch (msg.type) {

    // ── Timer ────────────────────────────────────────────────────────────────

    case 'timerStart':
      appState.timer = startTimer(appState.timer);
      await persistState(); broadcastState(); break;

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

    // ── Tasks (manual CRUD) ──────────────────────────────────────────────────

    case 'createTask': {
      appState.tasks.push(msg.task);
      await persistState(); broadcastState();
      githubSync((gh) => gh.writeTasks(appState.tasks, `task: add ${msg.task.title}`));
      break;
    }

    case 'updateTask': {
      appState.tasks = appState.tasks.map((t) => t.id === msg.task.id ? msg.task : t);
      await persistState(); broadcastState();
      githubSync((gh) => gh.writeTasks(appState.tasks, `task: update ${msg.task.title}`));
      break;
    }

    case 'deleteTask': {
      appState.tasks = appState.tasks.filter((t) => t.id !== msg.id);
      await persistState(); broadcastState();
      githubSync((gh) => gh.writeTasks(appState.tasks, `task: delete ${msg.id}`));
      break;
    }

    // ── AI ───────────────────────────────────────────────────────────────────

    case 'aiCommand': {
      if (!settings.ai) {
        port.postMessage({ type: 'error', message: 'AI not configured. Open Settings.' });
        break;
      }
      port.postMessage({ type: 'aiThinking' });
      try {
        const ai  = new AIClient(settings.ai);
        const res = await ai.sendCommand(
          msg.prompt, appState.tasks, appState.memory, appState.calendarCache, msg.imageData
        );

        if (settings.autoApproveAI || !res.requiresApproval) {
          await doApplyAI(res, msg.prompt, port);
        } else {
          const { tasks: preview } = applyActions(appState.tasks, appState.memory, res.actions);
          const diff = computeDiff(appState.tasks, preview);
          port.postMessage({ type: 'aiPendingApproval', response: res, diff });
        }
      } catch (e) {
        port.postMessage({ type: 'error', message: (e as Error).message });
      }
      break;
    }

    case 'aiApprove':
      await doApplyAI(msg.response, msg.prompt, port);
      break;

    case 'aiReject':
      port.postMessage({ type: 'aiRejected' });
      break;

    case 'undoLast': {
      const snaps = await Storage.getSnapshots();
      if (snaps.length < 2) {
        port.postMessage({ type: 'error', message: 'Nothing to undo.' }); break;
      }
      const prev = snaps[1];
      appState.tasks  = prev.tasks;
      appState.memory = prev.memory;
      await persistState(); broadcastState();
      githubSync(async (gh) => {
        await Promise.all([
          gh.writeTasks(appState.tasks,   'undo: revert tasks'),
          gh.writeMemory(appState.memory, 'undo: revert memory'),
        ]);
      });
      port.postMessage({ type: 'undoComplete' });
      break;
    }

    case 'revertToSnapshot': {
      const snaps = await Storage.getSnapshots();
      const snap  = snaps.find((s) => s.id === msg.snapshotId);
      if (!snap) break;
      appState.tasks  = snap.tasks;
      appState.memory = snap.memory;
      await persistState(); broadcastState();
      githubSync(async (gh) => {
        await Promise.all([
          gh.writeTasks(appState.tasks,   `revert: snapshot ${snap.id}`),
          gh.writeMemory(appState.memory, `revert: snapshot ${snap.id}`),
        ]);
      });
      break;
    }

    case 'syncNow': {
      if (!settings.github) {
        port.postMessage({ type: 'error', message: 'GitHub not configured.' }); break;
      }
      try   { await syncFromGitHub(); port.postMessage({ type: 'syncComplete' }); }
      catch (e) { port.postMessage({ type: 'error', message: (e as Error).message }); }
      break;
    }

    // ── Settings ─────────────────────────────────────────────────────────────

    case 'settingsUpdated':
      settings = msg.settings;
      await Storage.setSettings(settings);
      broadcastState();
      break;

    // ── Block state ───────────────────────────────────────────────────────────

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

    // ── Gmail ─────────────────────────────────────────────────────────────────

    case 'gmailScan': {
      if (!settings.google?.accessToken) {
        port.postMessage({ type: 'error', message: 'Gmail not connected.' }); break;
      }
      try {
        const gmail    = new GmailClient(settings.google.accessToken);
        const messages = await gmail.getRecentUnread();
        port.postMessage({ type: 'gmailMessages', messages });
      } catch (e) {
        port.postMessage({ type: 'error', message: (e as Error).message });
      }
      break;
    }
  }
}

// ── AI apply helper ───────────────────────────────────────────────────────────

async function doApplyAI(
  response: AIResponse,
  prompt:   string,
  port:     browser.runtime.Port,
): Promise<void> {
  const before = clone(appState.tasks);
  const { tasks, memory, calendarRequests } = applyActions(
    appState.tasks, appState.memory, response.actions
  );
  appState.tasks  = tasks;
  appState.memory = memory;
  await persistState();
  broadcastState();

  if (calendarRequests.length && settings.google?.accessToken) {
    const cal = new CalendarClient(settings.google.accessToken);
    calendarRequests.forEach((r) => cal.createEvent(r).catch(console.warn));
  }

  if (settings.github) {
    const gh = new GitHubClient(settings.github);
    commitChange(gh, before, tasks, memory, prompt, response.actions.map((a) => a.type))
      .catch(console.warn);
  }

  port.postMessage({ type: 'aiComplete', message: response.message });
}

// ── GitHub sync ───────────────────────────────────────────────────────────────

async function syncFromGitHub(): Promise<void> {
  if (!settings.github) return;
  const gh = new GitHubClient(settings.github);
  await gh.bootstrap();
  const [tasks, memory] = await Promise.all([gh.readTasks(), gh.readMemory()]);
  appState.tasks       = tasks;
  appState.memory      = memory;
  appState.lastSyncedAt = isoNow();
  await persistState();
  broadcastState();
}

/** Fire-and-forget GitHub operation, guarded by settings check. */
function githubSync(fn: (gh: GitHubClient) => Promise<void>): void {
  if (!settings.github) return;
  const gh = new GitHubClient(settings.github);
  fn(gh).catch((e) => console.warn('[styl] gh sync:', e));
}

// ── Persistence ───────────────────────────────────────────────────────────────

async function persistState(): Promise<void> {
  await Storage.setState(appState);
}

// ── Site blocking ─────────────────────────────────────────────────────────────

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

// ── Helpers ───────────────────────────────────────────────────────────────────

function defaultMemory() {
  return {
    preferences:      {} as Record<string, unknown>,
    recurring_events: [] as Array<{ name: string; pattern: string }>,
    habits:           [] as string[],
    task_patterns:    {} as Record<string, unknown>,
    known_entities:   {} as Record<string, string>,
  };
}
