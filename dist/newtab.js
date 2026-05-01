"use strict";
(() => {
  // src/shared/utils.ts
  function fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

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

  // src/newtab/index.ts
  var RING_C = 2 * Math.PI * 68;
  var DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
  var MONTHS = [
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December"
  ];
  var QUOTES = [
    "The secret of getting ahead is getting started.",
    "Focus on being productive instead of busy.",
    "Do something today that your future self will thank you for.",
    "Small steps every day lead to big results.",
    "The only way to do great work is to love what you do.",
    "Energy flows where attention goes.",
    "Discipline is choosing between what you want now and what you want most.",
    "Work hard in silence. Let your results make the noise.",
    "Progress, not perfection.",
    "One task at a time. Done well.",
    "Deep work is the ability to focus without distraction.",
    "Create with intention, rest with purpose.",
    "Your future self is watching. Choose well.",
    "The quality of your attention determines the quality of your work.",
    "What you do today can improve all your tomorrows."
  ];
  var port = null;
  var state = null;
  var isEditing = false;
  var timerTick = null;
  function liveRemaining() {
    const t = state?.timer;
    if (!t) return 0;
    if (!t.isRunning || t.startTime === null) return Math.max(0, t.pausedTimeRemaining);
    const elapsed = Math.floor((Date.now() - t.startTime) / 1e3);
    return Math.max(0, t.pausedTimeRemaining - elapsed);
  }
  function tickTimer() {
    const remaining = liveRemaining();
    if (!isEditing) {
      const el = document.getElementById("time-text");
      if (el) el.textContent = fmt(remaining);
    }
    const total = state?.timer.sessionTotal ?? 1;
    const offset = (1 - Math.min(1, Math.max(0, total > 0 ? remaining / total : 1))) * RING_C;
    const ring = document.getElementById("progress-ring");
    if (ring) ring.style.strokeDashoffset = String(offset);
  }
  function syncTimerTick() {
    if (state?.timer.isRunning) {
      if (!timerTick) timerTick = setInterval(tickTimer, 1e3);
    } else {
      if (timerTick) {
        clearInterval(timerTick);
        timerTick = null;
      }
    }
  }
  function connect() {
    port = browser.runtime.connect({ name: "newtab" });
    port.onMessage.addListener((msg) => {
      if (msg.type === "stateUpdate") {
        state = msg.state;
        renderTimer();
        renderAddMinBtn();
        syncTimerTick();
        if (msg.event === "timerComplete") playChime();
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 400);
    });
  }
  function send(msg) {
    port?.postMessage(msg);
  }
  function updateClock() {
    const now = /* @__PURE__ */ new Date();
    const h = now.getHours();
    const m = now.getMinutes();
    const ampm = h >= 12 ? "PM" : "AM";
    const hh = h % 12 || 12;
    document.getElementById("clock").textContent = `${String(hh).padStart(2, "0")}:${String(m).padStart(2, "0")} ${ampm}`;
    document.getElementById("date").textContent = `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;
    document.getElementById("greeting").textContent = h >= 5 && h < 12 ? "Good morning" : h >= 12 && h < 17 ? "Good afternoon" : h >= 17 && h < 21 ? "Good evening" : "Good night";
    const cls = h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 21 ? "evening" : "night";
    if (!document.body.classList.contains(cls)) document.body.className = cls;
  }
  function startClock() {
    updateClock();
    const ms = 1e3 - Date.now() % 1e3;
    setTimeout(() => {
      updateClock();
      setInterval(updateClock, 1e3);
    }, ms);
  }
  function renderTimer() {
    if (!state) return;
    const t = state.timer;
    document.querySelectorAll(".mode-tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.mode === t.mode);
    });
    if (!isEditing) {
      document.getElementById("time-text").textContent = fmt(liveRemaining());
    }
    const progress = t.sessionTotal > 0 ? liveRemaining() / t.sessionTotal : 1;
    const offset = (1 - Math.min(1, Math.max(0, progress))) * RING_C;
    const ring = document.getElementById("progress-ring");
    ring.style.strokeDashoffset = String(offset);
    ring.className.baseVal = "ring-fg" + (t.mode === "break" ? " break-mode" : t.mode === "longBreak" ? " long-mode" : "");
    document.getElementById("start-pause-btn").textContent = t.isRunning ? "Pause" : "Start";
    const dots = document.getElementById("sessions-dots");
    dots.innerHTML = "";
    const pos = t.sessionsCompleted % 4;
    for (let i = 0; i < 4; i++) {
      const d = document.createElement("div");
      d.className = "s-dot" + (i < pos ? " filled" : "");
      dots.appendChild(d);
    }
    document.getElementById("sessions-label").textContent = `${t.sessionsCompleted} session${t.sessionsCompleted !== 1 ? "s" : ""} completed`;
  }
  function renderAddMinBtn() {
    const btn = document.getElementById("add-min-btn");
    btn.classList.toggle("hidden", !state?.timer.isRunning);
  }
  function enterEditMode() {
    if (isEditing || !state) return;
    isEditing = true;
    if (state.timer.isRunning) send({ type: "timerPause" });
    const mode = state.timer.mode;
    const minutes = Math.round(state.timer.pausedTimeRemaining / 60);
    document.getElementById("time-text").classList.add("hidden");
    document.getElementById("time-editor").classList.remove("hidden");
    const input = document.getElementById("time-edit");
    input.value = String(minutes);
    input.focus();
    input.select();
    buildPresets(mode, minutes);
    document.getElementById("preset-bar").classList.remove("hidden");
  }
  function exitEditMode(save = true) {
    if (!isEditing) return;
    isEditing = false;
    if (save) {
      const raw = parseInt(document.getElementById("time-edit").value, 10);
      const min = isNaN(raw) ? null : Math.min(Math.max(raw, 1), 180);
      if (min) saveMinutes(min);
    }
    document.getElementById("time-text").classList.remove("hidden");
    document.getElementById("time-editor").classList.add("hidden");
    document.getElementById("preset-bar").classList.add("hidden");
  }
  function saveMinutes(minutes) {
    const secs = minutes * 60;
    const mode = state?.timer.mode ?? "focus";
    send({
      type: "timerUpdateSettings",
      focusDuration: mode === "focus" ? secs : state?.timer.focusDuration,
      breakDuration: mode === "break" ? secs : state?.timer.breakDuration,
      longBreakDuration: mode === "longBreak" ? secs : state?.timer.longBreakDuration
    });
  }
  function buildPresets(mode, current) {
    const PRESETS = {
      focus: [15, 20, 25, 30, 45, 60, 90],
      break: [5, 10, 15],
      longBreak: [10, 15, 20, 25, 30]
    };
    const bar = document.getElementById("preset-bar");
    bar.innerHTML = "";
    PRESETS[mode].forEach((val) => {
      const chip = document.createElement("button");
      chip.className = "preset-chip" + (val === current ? " active" : "");
      chip.textContent = `${val}m`;
      chip.addEventListener("mousedown", (e) => e.preventDefault());
      chip.addEventListener("click", () => {
        document.getElementById("time-edit").value = String(val);
        exitEditMode(true);
      });
      bar.appendChild(chip);
    });
  }
  function loadQuote() {
    const idx = Math.floor(Date.now() / 864e5) % QUOTES.length;
    document.getElementById("quote").textContent = `"${QUOTES[idx]}"`;
  }
  function loadDailyFocus() {
    const today = (/* @__PURE__ */ new Date()).toDateString();
    const savedDay = localStorage.getItem("styl_focus_date");
    const savedVal = localStorage.getItem("styl_focus_text");
    const input = document.getElementById("focus-input");
    if (savedDay === today && savedVal) input.value = savedVal;
    else {
      localStorage.removeItem("styl_focus_text");
      localStorage.setItem("styl_focus_date", today);
    }
  }
  var DB_NAME = "styl";
  var DB_STORE = "wallpaper";
  var _db = null;
  var _wpUrl = null;
  function openDB() {
    if (_db) return Promise.resolve(_db);
    return new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
      req.onsuccess = () => {
        _db = req.result;
        res(_db);
      };
      req.onerror = () => rej(req.error);
    });
  }
  async function wpSave(blob) {
    const db = await openDB();
    return new Promise((res, rej) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).put(blob, "img");
      tx.oncomplete = () => res();
      tx.onerror = () => rej(tx.error);
    });
  }
  async function wpLoad() {
    const db = await openDB();
    return new Promise((res) => {
      const tx = db.transaction(DB_STORE, "readonly");
      const req = tx.objectStore(DB_STORE).get("img");
      req.onsuccess = () => res(req.result);
      req.onerror = () => res(null);
    });
  }
  async function wpClear() {
    const db = await openDB();
    return new Promise((res) => {
      const tx = db.transaction(DB_STORE, "readwrite");
      tx.objectStore(DB_STORE).delete("img");
      tx.oncomplete = () => res();
      tx.onerror = () => res();
    });
  }
  function applyBlob(blob) {
    if (_wpUrl) URL.revokeObjectURL(_wpUrl);
    _wpUrl = URL.createObjectURL(blob);
    document.body.style.backgroundImage = `url(${_wpUrl})`;
    document.body.classList.add("has-wallpaper");
    document.getElementById("wallpaper-remove-btn").classList.remove("hidden");
  }
  function removeWallpaper() {
    if (_wpUrl) {
      URL.revokeObjectURL(_wpUrl);
      _wpUrl = null;
    }
    document.body.style.backgroundImage = "";
    document.body.classList.remove("has-wallpaper");
    document.getElementById("wallpaper-remove-btn").classList.add("hidden");
    wpClear();
  }
  async function initWallpaper() {
    const blob = await wpLoad();
    if (blob) applyBlob(blob);
  }
  function wireEvents() {
    document.getElementById("time-text").addEventListener("click", enterEditMode);
    document.getElementById("time-edit").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        exitEditMode(true);
      }
      if (e.key === "Escape") exitEditMode(false);
    });
    document.getElementById("time-edit").addEventListener("blur", () => {
      setTimeout(() => {
        if (isEditing) exitEditMode(true);
      }, 150);
    });
    document.querySelectorAll(".mode-tab").forEach((el) => {
      el.addEventListener(
        "click",
        () => send({ type: "timerSetMode", mode: el.dataset.mode })
      );
    });
    document.getElementById("start-pause-btn").addEventListener("click", () => {
      if (!state) return;
      send({ type: state.timer.isRunning ? "timerPause" : "timerStart" });
    });
    document.getElementById("reset-btn").addEventListener("click", () => send({ type: "timerReset" }));
    document.getElementById("skip-btn").addEventListener("click", () => send({ type: "timerSkip" }));
    document.getElementById("add-min-btn").addEventListener("click", () => send({ type: "timerAddMinute" }));
    const focusInput = document.getElementById("focus-input");
    focusInput.addEventListener(
      "input",
      () => localStorage.setItem("styl_focus_text", focusInput.value)
    );
    const wpFile = document.getElementById("wallpaper-file");
    document.getElementById("wallpaper-upload-btn").addEventListener("click", () => wpFile.click());
    wpFile.addEventListener("change", async () => {
      const file = wpFile.files?.[0];
      if (!file) return;
      wpFile.value = "";
      await wpSave(file);
      applyBlob(file);
    });
    document.getElementById("wallpaper-remove-btn").addEventListener("click", removeWallpaper);
  }
  wireEvents();
  startClock();
  connect();
  loadDailyFocus();
  loadQuote();
  initWallpaper();
  applyTheme();
})();
//# sourceMappingURL=newtab.js.map
