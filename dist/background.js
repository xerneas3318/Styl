"use strict";
(() => {
  // src/shared/storage.ts
  var KEY_STATE = "styl_state";
  var KEY_SETTINGS = "styl_settings";
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
    setSettings: (s) => set(KEY_SETTINGS, s)
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
  var IS_FIREFOX = browser.runtime.getURL("").startsWith("moz-extension://");
  var DEFAULT_PRESETS = {
    social: [
      "instagram.com",
      "facebook.com",
      "twitter.com",
      "x.com",
      "tiktok.com",
      "reddit.com",
      "snapchat.com",
      "pinterest.com",
      "threads.net",
      "linkedin.com",
      "tumblr.com"
    ],
    video: ["youtube.com", "netflix.com", "twitch.tv", "hulu.com", "disneyplus.com", "primevideo.com", "vimeo.com"],
    news: ["cnn.com", "bbc.com", "nytimes.com", "buzzfeed.com", "theguardian.com", "huffpost.com", "dailymail.co.uk"]
  };
  var appState = {
    timer: defaultTimerState(),
    blockState: {
      enabled: true,
      alwaysSites: [],
      focusSites: [],
      gate: "none",
      bypassPassword: "",
      presets: { ...DEFAULT_PRESETS }
    }
  };
  var settings = {
    focusDuration: 25 * 60,
    breakDuration: 5 * 60,
    longBreakDuration: 15 * 60,
    theme: "dark",
    fontSize: "medium",
    apiKey: "",
    timerSound: true
  };
  var tempBypass = /* @__PURE__ */ new Map();
  var ports = /* @__PURE__ */ new Set();
  (async function boot() {
    const [savedState, savedSettings] = await Promise.all([
      Storage.getState(),
      Storage.getSettings()
    ]);
    if (savedState) {
      appState = savedState;
      const bs = appState.blockState;
      if (!bs.alwaysSites && !bs.focusSites) {
        appState.blockState.focusSites = bs.sites ?? [];
        appState.blockState.alwaysSites = [];
      }
      if (!appState.blockState.alwaysSites) appState.blockState.alwaysSites = [];
      if (!appState.blockState.focusSites) appState.blockState.focusSites = [];
      if (!appState.blockState.gate) appState.blockState.gate = "none";
      if (appState.blockState.bypassPassword === void 0) appState.blockState.bypassPassword = "";
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
    if (savedSettings) settings = savedSettings;
    browser.alarms.create(ALARM_KEEPALIVE, { periodInMinutes: 0.4 });
    updateBadge();
    await syncDnrRules();
  })();
  browser.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === ALARM_COMPLETE) {
      const { state, prevMode } = onTimerComplete(appState.timer);
      appState.timer = state;
      if (settings.timerSound) {
        browser.notifications.create("styl-done", {
          type: "basic",
          iconUrl: browser.runtime.getURL("icons/icon.svg"),
          title: "Styl",
          message: prevMode === "focus" ? `Time for a ${state.mode === "longBreak" ? "long " : ""}break!` : "Break over \u2014 back to focus."
        });
      }
      persistState();
      broadcast({ type: "stateUpdate", state: appState, event: "timerComplete" });
      updateBadge();
      syncDnrRules();
    }
    if (alarm.name === ALARM_BADGE_TICK) {
      updateBadge();
    }
    if (alarm.name === ALARM_KEEPALIVE && appState.timer.isRunning) {
      broadcast({ type: "stateUpdate", state: appState });
      updateBadge();
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
    updateBadge();
  }
  var ALARM_BADGE_TICK = "styl-badge-tick";
  function updateBadge() {
    browser.alarms.clear(ALARM_BADGE_TICK);
    if (!appState.timer.isRunning) {
      browser.action.setBadgeText({ text: "" });
      return;
    }
    const secs = Math.max(0, getTimeRemaining(appState.timer));
    const mins = Math.ceil(secs / 60);
    browser.action.setBadgeText({ text: String(mins) });
    browser.action.setBadgeBackgroundColor({ color: "#ffffff" });
    browser.action.setBadgeTextColor({ color: "#000000" });
    if (secs > 0) {
      const secsUntilFlip = secs % 60 || 60;
      browser.alarms.create(ALARM_BADGE_TICK, { delayInMinutes: secsUntilFlip / 60 });
    }
  }
  var getDnr = () => globalThis.chrome?.declarativeNetRequest;
  async function syncDnrRules() {
    if (IS_FIREFOX) return;
    const dnr = getDnr();
    if (!dnr) return;
    const existing = await dnr.getDynamicRules();
    const removeIds = existing.map((r) => r.id);
    const rules = [];
    let id = 1;
    const blockedUrl = browser.runtime.getURL("blocked/blocked.html");
    const { enabled, alwaysSites, focusSites, gate } = appState.blockState;
    if (enabled) {
      const now = Date.now();
      for (const site of alwaysSites) {
        const exp = tempBypass.get(site);
        if (exp !== void 0 && now < exp) continue;
        rules.push(makeDnrRule(id++, site, "always", gate, blockedUrl));
      }
      if (appState.timer.isRunning && appState.timer.mode === "focus") {
        for (const site of focusSites) {
          const exp = tempBypass.get(site);
          if (exp !== void 0 && now < exp) continue;
          rules.push(makeDnrRule(id++, site, "focus", gate, blockedUrl));
        }
      }
    }
    await dnr.updateDynamicRules({ removeRuleIds: removeIds, addRules: rules });
  }
  function makeDnrRule(id, site, bm, gate, blockedUrl) {
    return {
      id,
      priority: 1,
      action: {
        type: "redirect",
        redirect: {
          url: `${blockedUrl}?site=${encodeURIComponent(site)}&gate=${encodeURIComponent(gate)}&bm=${bm}`
        }
      },
      condition: {
        urlFilter: `||${site}^`,
        resourceTypes: ["main_frame"]
      }
    };
  }
  browser.runtime.onMessage.addListener(
    (msg, _sender, sendResponse) => {
      if (msg.type === "getTimerState") {
        sendResponse({ timeRemaining: getTimeRemaining(appState.timer), mode: appState.timer.mode });
        return false;
      }
      if (msg.type === "getBlockState") {
        sendResponse({ blockState: appState.blockState });
        return false;
      }
      if (msg.type === "checkBypassPassword") {
        const pw = appState.blockState.bypassPassword;
        sendResponse({ allowed: pw !== "" && msg.password === pw });
        return false;
      }
      if (msg.type === "requestBypass") {
        const site = msg.site;
        if (site) {
          tempBypass.set(site, Date.now() + 5e3);
          if (!IS_FIREFOX) {
            syncDnrRules().then(() => {
              sendResponse({ ok: true });
              setTimeout(() => {
                tempBypass.delete(site);
                syncDnrRules();
              }, 5e3);
            });
            return true;
          }
        }
        sendResponse({ ok: true });
        return false;
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
        await syncDnrRules();
        redirectBlockedTabs();
        break;
      case "timerPause":
        appState.timer = pauseTimer(appState.timer);
        await persistState();
        broadcastState();
        syncDnrRules();
        break;
      case "timerReset":
        appState.timer = resetTimer(appState.timer);
        await persistState();
        broadcastState();
        syncDnrRules();
        break;
      case "timerSkip":
        appState.timer = skipTimer(appState.timer);
        await persistState();
        broadcastState();
        syncDnrRules();
        break;
      case "timerSetMode":
        appState.timer = setTimerMode(appState.timer, msg.mode);
        await persistState();
        broadcastState();
        syncDnrRules();
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
        await syncDnrRules();
        if (msg.enabled) redirectBlockedTabs();
        else unblockFreedTabs();
        break;
      case "setAlwaysSites":
        appState.blockState.alwaysSites = msg.sites;
        await persistState();
        broadcast({ type: "blockStateUpdate", blockState: { ...appState.blockState } });
        await syncDnrRules();
        redirectBlockedTabs();
        unblockFreedTabs();
        break;
      case "setFocusSites":
        appState.blockState.focusSites = msg.sites;
        await persistState();
        broadcast({ type: "blockStateUpdate", blockState: { ...appState.blockState } });
        await syncDnrRules();
        unblockFreedTabs();
        break;
      case "setBlockGate":
        appState.blockState.gate = msg.gate;
        if (msg.gate === "password" && msg.password !== void 0) {
          appState.blockState.bypassPassword = msg.password;
        } else if (msg.gate !== "password") {
          appState.blockState.bypassPassword = "";
        }
        await persistState();
        broadcast({ type: "blockStateUpdate", blockState: { ...appState.blockState } });
        syncDnrRules();
        break;
      case "setPresets":
        appState.blockState.presets = msg.presets;
        await persistState();
        broadcast({ type: "blockStateUpdate", blockState: { ...appState.blockState } });
        break;
      case "setTimerSound":
        settings.timerSound = msg.enabled;
        await Storage.setSettings(settings);
        break;
    }
  }
  function isPermBlocked(host) {
    const { enabled, alwaysSites, focusSites } = appState.blockState;
    if (!enabled) return false;
    if (alwaysSites.some((s) => host === s || host.endsWith("." + s))) return true;
    if (appState.timer.isRunning && appState.timer.mode === "focus") {
      return focusSites.some((s) => host === s || host.endsWith("." + s));
    }
    return false;
  }
  function getBlockInfo(host) {
    const { enabled, alwaysSites, focusSites } = appState.blockState;
    if (!enabled) return null;
    const exp = tempBypass.get(host);
    if (exp !== void 0) {
      if (Date.now() < exp) return null;
      tempBypass.delete(host);
    }
    if (alwaysSites.some((s) => host === s || host.endsWith("." + s))) {
      return { bm: "always" };
    }
    if (appState.timer.isRunning && appState.timer.mode === "focus") {
      if (focusSites.some((s) => host === s || host.endsWith("." + s))) {
        return { bm: "focus" };
      }
    }
    return null;
  }
  async function redirectBlockedTabs() {
    if (!appState.blockState.enabled) return;
    const { gate } = appState.blockState;
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
      const info = getBlockInfo(host);
      if (info) {
        const blockedUrl = browser.runtime.getURL("blocked/blocked.html") + "?site=" + encodeURIComponent(host) + "&from=" + encodeURIComponent(tab.url) + "&gate=" + gate + "&bm=" + info.bm;
        browser.tabs.update(tab.id, { url: blockedUrl }).catch(() => {
        });
      }
    }
  }
  async function unblockFreedTabs() {
    const blockedBase = browser.runtime.getURL("blocked/blocked.html");
    const tabs = await browser.tabs.query({});
    for (const tab of tabs) {
      if (!tab.url || !tab.id) continue;
      if (!tab.url.startsWith(blockedBase)) continue;
      let params;
      try {
        params = new URL(tab.url).searchParams;
      } catch {
        continue;
      }
      const site = params.get("site");
      const from = params.get("from") || (site ? "https://" + site : null);
      if (!site || !from) continue;
      if (!isPermBlocked(site)) {
        browser.tabs.update(tab.id, { url: from }).catch(() => {
        });
      }
    }
  }
  async function persistState() {
    await Storage.setState(appState);
  }
  if (IS_FIREFOX) {
    browser.webRequest.onBeforeRequest.addListener(
      (details) => {
        let host;
        try {
          host = new URL(details.url).hostname.replace(/^www\./, "");
        } catch {
          return {};
        }
        const info = getBlockInfo(host);
        if (!info) return {};
        const { gate } = appState.blockState;
        return {
          redirectUrl: browser.runtime.getURL("blocked/blocked.html") + "?site=" + encodeURIComponent(host) + "&from=" + encodeURIComponent(details.url) + "&gate=" + gate + "&bm=" + info.bm
        };
      },
      { urls: ["<all_urls>"], types: ["main_frame"] },
      ["blocking"]
    );
  }
})();
