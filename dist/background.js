"use strict";
(() => {
  // src/shared/storage.ts
  var KEY_STATE = "styl_state";
  var KEY_SETTINGS = "styl_settings";
  var KEY_SNAPSHOTS = "styl_snapshots";
  var MAX_SNAPSHOTS = 50;
  async function get(key) {
    const result = await browser.storage.local.get(key);
    return result[key] ?? null;
  }
  function set(key, value) {
    return browser.storage.local.set({ [key]: value });
  }
  var Storage = {
    getState: () => get(KEY_STATE),
    setState: (s) => set(KEY_STATE, s),
    getSettings: () => get(KEY_SETTINGS),
    setSettings: (s) => set(KEY_SETTINGS, s),
    getSnapshots: () => get(KEY_SNAPSHOTS).then((s) => s ?? []),
    setSnapshots: (s) => set(KEY_SNAPSHOTS, s),
    async pushSnapshot(snap) {
      const snaps = await Storage.getSnapshots();
      snaps.unshift(snap);
      if (snaps.length > MAX_SNAPSHOTS) snaps.length = MAX_SNAPSHOTS;
      await Storage.setSnapshots(snaps);
    }
  };

  // src/background/timer.ts
  var ALARM_COMPLETE = "styl-timer-complete";
  var ALARM_KEEPALIVE = "styl-keepalive";
  function defaultTimerState() {
    return {
      mode: "focus",
      isRunning: false,
      startTime: null,
      pausedTimeRemaining: 25 * 60,
      sessionTotal: 25 * 60,
      focusDuration: 25 * 60,
      breakDuration: 5 * 60,
      longBreakDuration: 15 * 60,
      sessionsCompleted: 0
    };
  }
  function getTimeRemaining(t) {
    if (!t.isRunning || t.startTime === null) {
      return Math.max(0, t.pausedTimeRemaining);
    }
    const elapsed = Math.floor((Date.now() - t.startTime) / 1e3);
    return Math.max(0, t.pausedTimeRemaining - elapsed);
  }
  function durationFor(t, mode) {
    switch (mode) {
      case "focus":
        return t.focusDuration;
      case "break":
        return t.breakDuration;
      case "longBreak":
        return t.longBreakDuration;
    }
  }
  function startTimer(t) {
    if (t.isRunning || t.pausedTimeRemaining <= 0) return t;
    browser.alarms.create(ALARM_COMPLETE, {
      delayInMinutes: t.pausedTimeRemaining / 60
    });
    return { ...t, isRunning: true, startTime: Date.now() };
  }
  function pauseTimer(t) {
    if (!t.isRunning) return t;
    browser.alarms.clear(ALARM_COMPLETE);
    return {
      ...t,
      isRunning: false,
      startTime: null,
      pausedTimeRemaining: getTimeRemaining(t)
    };
  }
  function resetTimer(t) {
    browser.alarms.clear(ALARM_COMPLETE);
    const duration = durationFor(t, t.mode);
    return {
      ...t,
      isRunning: false,
      startTime: null,
      pausedTimeRemaining: duration,
      sessionTotal: duration
    };
  }
  function skipTimer(t) {
    browser.alarms.clear(ALARM_COMPLETE);
    let { mode, sessionsCompleted } = t;
    if (mode === "focus") {
      sessionsCompleted++;
      mode = sessionsCompleted % 4 === 0 ? "longBreak" : "break";
    } else {
      mode = "focus";
    }
    const duration = durationFor({ ...t, mode }, mode);
    return {
      ...t,
      mode,
      sessionsCompleted,
      isRunning: false,
      startTime: null,
      pausedTimeRemaining: duration,
      sessionTotal: duration
    };
  }
  function setTimerMode(t, mode) {
    browser.alarms.clear(ALARM_COMPLETE);
    const duration = durationFor({ ...t, mode }, mode);
    return {
      ...t,
      mode,
      isRunning: false,
      startTime: null,
      pausedTimeRemaining: duration,
      sessionTotal: duration
    };
  }
  function addMinute(t) {
    const newRemaining = getTimeRemaining(t) + 60;
    if (t.isRunning) {
      browser.alarms.clear(ALARM_COMPLETE);
      browser.alarms.create(ALARM_COMPLETE, { delayInMinutes: newRemaining / 60 });
    }
    return {
      ...t,
      pausedTimeRemaining: t.isRunning ? t.pausedTimeRemaining + 60 : newRemaining,
      sessionTotal: t.sessionTotal + 60,
      startTime: t.isRunning ? t.startTime : null
    };
  }
  function onTimerComplete(t) {
    const prevMode = t.mode;
    let { mode, sessionsCompleted } = t;
    if (mode === "focus") {
      sessionsCompleted++;
      mode = sessionsCompleted % 4 === 0 ? "longBreak" : "break";
    } else {
      mode = "focus";
    }
    const duration = durationFor({ ...t, mode }, mode);
    return {
      prevMode,
      state: {
        ...t,
        mode,
        sessionsCompleted,
        isRunning: false,
        startTime: null,
        pausedTimeRemaining: duration,
        sessionTotal: duration
      }
    };
  }

  // src/background/index.ts
  var appState = {
    timer: defaultTimerState(),
    blockState: { enabled: true, sites: [] }
  };
  var settings = {
    focusDuration: 25 * 60,
    breakDuration: 5 * 60,
    longBreakDuration: 15 * 60
  };
  var ports = /* @__PURE__ */ new Set();
  (async function boot() {
    const [savedState, savedSettings] = await Promise.all([
      Storage.getState(),
      Storage.getSettings()
    ]);
    if (savedState) {
      appState = savedState;
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
    if (savedSettings) settings = savedSettings;
    browser.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 });
  })();
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_COMPLETE) {
      const { state, prevMode } = onTimerComplete(appState.timer);
      appState.timer = state;
      browser.notifications.create("styl-done", {
        type: "basic",
        iconUrl: browser.runtime.getURL("icons/icon.svg"),
        title: "Styl",
        message: prevMode === "focus" ? `Time for a ${state.mode === "longBreak" ? "long " : ""}break!` : "Break over \u2014 back to focus."
      });
      persistState();
      broadcast({ type: "stateUpdate", state: appState, event: "timerComplete" });
    }
    if (alarm.name === ALARM_KEEPALIVE && appState.timer.isRunning) {
      broadcast({ type: "stateUpdate", state: appState });
    }
  });
  browser.runtime.onConnect.addListener((port) => {
    ports.add(port);
    port.postMessage({ type: "stateUpdate", state: appState });
    port.onMessage.addListener((msg) => handleMessage(msg, port));
    port.onDisconnect.addListener(() => ports.delete(port));
  });
  function broadcast(msg) {
    for (const p of ports) {
      try {
        p.postMessage(msg);
      } catch {
        ports.delete(p);
      }
    }
  }
  function broadcastState() {
    broadcast({ type: "stateUpdate", state: appState });
  }
  browser.runtime.onMessage.addListener(
    (msg, _sender, sendResponse) => {
      if (msg.type === "getTimerState") {
        sendResponse({ timeRemaining: getTimeRemaining(appState.timer), mode: appState.timer.mode });
      }
      return false;
    }
  );
  async function handleMessage(msg, _port) {
    switch (msg.type) {
      case "timerStart":
        appState.timer = startTimer(appState.timer);
        await persistState();
        broadcastState();
        redirectBlockedTabs();
        break;
      case "timerPause":
        appState.timer = pauseTimer(appState.timer);
        await persistState();
        broadcastState();
        break;
      case "timerReset":
        appState.timer = resetTimer(appState.timer);
        await persistState();
        broadcastState();
        break;
      case "timerSkip":
        appState.timer = skipTimer(appState.timer);
        await persistState();
        broadcastState();
        break;
      case "timerSetMode":
        appState.timer = setTimerMode(appState.timer, msg.mode);
        await persistState();
        broadcastState();
        break;
      case "timerAddMinute":
        appState.timer = addMinute(appState.timer);
        await persistState();
        broadcastState();
        break;
      case "timerUpdateSettings": {
        const t = appState.timer;
        if (msg.focusDuration) appState.timer = { ...t, focusDuration: msg.focusDuration };
        if (msg.breakDuration) appState.timer = { ...appState.timer, breakDuration: msg.breakDuration };
        if (msg.longBreakDuration) appState.timer = { ...appState.timer, longBreakDuration: msg.longBreakDuration };
        if (!t.isRunning) appState.timer = resetTimer(appState.timer);
        await persistState();
        broadcastState();
        break;
      }
      case "setBlockEnabled":
        appState.blockState.enabled = msg.enabled;
        await persistState();
        broadcast({ type: "blockStateUpdate", blockState: { ...appState.blockState } });
        break;
      case "setBlockedSites":
        appState.blockState.sites = msg.sites;
        await persistState();
        broadcast({ type: "blockStateUpdate", blockState: { ...appState.blockState } });
        break;
    }
  }
  async function redirectBlockedTabs() {
    const { enabled, sites } = appState.blockState;
    if (!enabled || !sites.length) return;
    if (!appState.timer.isRunning || appState.timer.mode !== "focus") return;
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || !tab.id) continue;
      if (tab.url.startsWith("moz-extension://") || tab.url.startsWith("chrome-extension://")) continue;
      let host;
      try {
        host = new URL(tab.url).hostname.replace(/^www\./, "");
      } catch {
        continue;
      }
      const isBlocked = sites.some((s) => host === s || host.endsWith("." + s));
      if (isBlocked) {
        browser.tabs.update(tab.id, {
          url: browser.runtime.getURL("blocked/blocked.html") + "?site=" + encodeURIComponent(host)
        }).catch(() => {
        });
      }
    }
  }
  async function persistState() {
    await Storage.setState(appState);
  }
  browser.webRequest.onBeforeRequest.addListener(
    (details) => {
      const { enabled, sites } = appState.blockState;
      if (!enabled || !sites.length) return {};
      if (!appState.timer.isRunning || appState.timer.mode !== "focus") return {};
      let host;
      try {
        host = new URL(details.url).hostname.replace(/^www\./, "");
      } catch {
        return {};
      }
      const blocked = sites.some((s) => host === s || host.endsWith("." + s));
      if (!blocked) return {};
      return {
        redirectUrl: browser.runtime.getURL("blocked/blocked.html") + "?site=" + encodeURIComponent(host)
      };
    },
    { urls: ["<all_urls>"], types: ["main_frame"] },
    ["blocking"]
  );
})();
//# sourceMappingURL=background.js.map
