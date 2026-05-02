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

  // src/shared/theme.ts
  function applyThemeFromSettings(s) {
    const theme = s.theme ?? "dark";
    const fontSize = s.fontSize ?? "medium";
    const html = document.documentElement;
    const isLight = theme === "light" || theme === "system" && window.matchMedia("(prefers-color-scheme: light)").matches;
    html.classList.toggle("theme-light", isLight);
    html.classList.remove("size-small", "size-medium", "size-large");
    html.classList.add(`size-${fontSize}`);
  }
  async function applyTheme() {
    const s = await Storage.getSettings();
    applyThemeFromSettings(s ?? {});
    if (s?.theme === "system") {
      window.matchMedia("(prefers-color-scheme: light)").addEventListener("change", () => {
        applyThemeFromSettings(s);
      });
    }
  }

  // src/settings/index.ts
  var settings = {
    focusDuration: 25 * 60,
    breakDuration: 5 * 60,
    longBreakDuration: 15 * 60,
    theme: "dark",
    fontSize: "medium",
    apiKey: "",
    timerSound: true,
    annoyingLevel: "off",
    reminders: false
  };
  async function init() {
    const saved = await Storage.getSettings();
    if (saved) settings = { ...settings, ...saved };
    populateForm();
    await applyTheme();
  }
  function populateForm() {
    document.querySelectorAll("[data-theme]").forEach((el) => {
      el.classList.toggle("active", el.dataset.theme === (settings.theme ?? "dark"));
    });
    document.querySelectorAll("[data-size]").forEach((el) => {
      el.classList.toggle("active", el.dataset.size === (settings.fontSize ?? "medium"));
    });
    setVal("focus-dur", String(Math.round((settings.focusDuration ?? 25 * 60) / 60)));
    setVal("break-dur", String(Math.round((settings.breakDuration ?? 5 * 60) / 60)));
    setVal("long-break-dur", String(Math.round((settings.longBreakDuration ?? 15 * 60) / 60)));
    setVal("api-key", settings.apiKey ?? "");
    const level = settings.annoyingLevel ?? "off";
    document.querySelectorAll("[data-annoying]").forEach(
      (el) => el.classList.toggle("active", el.dataset.annoying === level)
    );
    updateAnnoyingDesc(level);
    document.getElementById("reminders").checked = settings.reminders ?? false;
  }
  function collectSettings() {
    return {
      ...settings,
      focusDuration: parseInt(getVal("focus-dur"), 10) * 60 || 25 * 60,
      breakDuration: parseInt(getVal("break-dur"), 10) * 60 || 5 * 60,
      longBreakDuration: parseInt(getVal("long-break-dur"), 10) * 60 || 15 * 60,
      apiKey: getVal("api-key")
    };
  }
  async function save() {
    settings = collectSettings();
    await Storage.setSettings(settings);
    notifyBackground();
    showStatus("Saved.", false);
  }
  function notifyBackground() {
    try {
      const port = browser.runtime.connect({ name: "settings" });
      port.postMessage({ type: "settingsUpdated", settings });
      port.disconnect();
    } catch {
    }
  }
  function getVal(id) {
    return document.getElementById(id).value.trim();
  }
  function setVal(id, v) {
    document.getElementById(id).value = v;
  }
  function showStatus(msg, isError) {
    const el = document.getElementById("status-msg");
    el.textContent = msg;
    el.className = `status-msg ${isError ? "error" : "ok"}`;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 4e3);
  }
  function initTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.tab;
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
        btn.classList.add("active");
        document.getElementById(`tab-${target}`).classList.remove("hidden");
      });
    });
  }
  function sendBg(msg) {
    try {
      const port = browser.runtime.connect({ name: "settings" });
      port.postMessage(msg);
      port.disconnect();
    } catch {
    }
  }
  var ANNOYING_DESCS = {
    off: "Off \u2014 bypassing goes straight through.",
    normal: "Normal \u2014 a second screen appears with the proceed button in a random spot.",
    high: "High \u2014 the proceed button jumps to a new position every 0.5 seconds."
  };
  function updateAnnoyingDesc(level) {
    const el = document.getElementById("annoying-desc");
    if (el) el.textContent = ANNOYING_DESCS[level] ?? "";
  }
  document.querySelectorAll("[data-annoying]").forEach(
    (el) => el.addEventListener("click", () => {
      const level = el.dataset.annoying;
      settings.annoyingLevel = level;
      document.querySelectorAll("[data-annoying]").forEach(
        (e) => e.classList.toggle("active", e.dataset.annoying === level)
      );
      updateAnnoyingDesc(level);
      sendBg({ type: "setAnnoyingLevel", level });
    })
  );
  document.getElementById("reminders").addEventListener("change", () => {
    settings.reminders = document.getElementById("reminders").checked;
    sendBg({ type: "setReminders", enabled: settings.reminders });
  });
  document.getElementById("save-btn").addEventListener("click", save);
  document.querySelectorAll("[data-theme]").forEach(
    (el) => el.addEventListener("click", () => {
      const theme = el.dataset.theme;
      settings = { ...settings, theme };
      document.querySelectorAll("[data-theme]").forEach(
        (e) => e.classList.toggle("active", e.dataset.theme === theme)
      );
      applyThemeFromSettings(settings);
    })
  );
  document.querySelectorAll("[data-size]").forEach(
    (el) => el.addEventListener("click", () => {
      const fontSize = el.dataset.size;
      settings = { ...settings, fontSize };
      document.querySelectorAll("[data-size]").forEach(
        (e) => e.classList.toggle("active", e.dataset.size === fontSize)
      );
      applyThemeFromSettings(settings);
    })
  );
  initTabs();
  init();
})();
//# sourceMappingURL=settings.js.map
