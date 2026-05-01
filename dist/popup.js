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

  // src/popup/index.ts
  var RING_C = 2 * Math.PI * 52;
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
  var DURATION_PRESETS = {
    focus: [15, 20, 25, 30, 45, 60, 90],
    break: [5, 10, 15],
    longBreak: [10, 15, 20, 25, 30]
  };
  var port = null;
  var state = null;
  var blockState = {
    enabled: true,
    alwaysSites: [],
    focusSites: [],
    gate: "none",
    bypassPassword: "",
    presets: { ...DEFAULT_PRESETS }
  };
  var isEditing = false;
  var currentPreset = "social";
  var timerTick = null;
  var soundEnabled = true;
  function liveRemaining() {
    const t = state?.timer;
    if (!t) return 0;
    if (!t.isRunning || t.startTime === null) return Math.max(0, t.pausedTimeRemaining);
    const elapsed = Math.floor((Date.now() - t.startTime) / 1e3);
    return Math.max(0, t.pausedTimeRemaining - elapsed);
  }
  function tickUI() {
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
      if (!timerTick) timerTick = setInterval(tickUI, 1e3);
    } else {
      if (timerTick) {
        clearInterval(timerTick);
        timerTick = null;
      }
    }
  }
  function updateMuteBtn() {
    const btn = document.getElementById("mute-btn");
    btn.classList.toggle("muted", !soundEnabled);
    btn.title = soundEnabled ? "Mute sound" : "Unmute sound";
    btn.querySelector(".icon-sound-on").classList.toggle("hidden", !soundEnabled);
    btn.querySelector(".icon-sound-off").classList.toggle("hidden", soundEnabled);
  }
  browser.storage.local.get("styl_settings").then((result) => {
    const s = result["styl_settings"];
    soundEnabled = s?.timerSound ?? true;
    updateMuteBtn();
  }).catch(() => {
  });
  function connect() {
    port = browser.runtime.connect({ name: "popup" });
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "stateUpdate":
          state = msg.state;
          blockState = msg.state.blockState ?? blockState;
          render();
          renderBlockPanel();
          renderPresetEditor();
          updateShield();
          if (msg.event === "timerComplete" && soundEnabled) playChime();
          break;
        case "blockStateUpdate":
          blockState = msg.blockState;
          renderBlockPanel();
          renderPresetEditor();
          updateShield();
          break;
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
  function render() {
    if (!state) return;
    const t = state.timer;
    document.querySelectorAll(".mode-tab").forEach(
      (el) => el.classList.toggle("active", el.dataset.mode === t.mode)
    );
    if (!isEditing) {
      document.getElementById("time-text").textContent = fmt(liveRemaining());
    }
    const progress = t.sessionTotal > 0 ? liveRemaining() / t.sessionTotal : 1;
    const offset = (1 - Math.min(1, Math.max(0, progress))) * RING_C;
    const ring = document.getElementById("progress-ring");
    ring.style.strokeDashoffset = String(offset);
    ring.className.baseVal = "ring-fg" + (t.mode === "break" ? " break-mode" : t.mode === "longBreak" ? " long-mode" : "");
    document.getElementById("start-pause-btn").textContent = t.isRunning ? "Pause" : "Start";
    document.getElementById("add-min-btn").classList.toggle("hidden", !t.isRunning);
    const dots = document.getElementById("sessions-dots");
    dots.innerHTML = "";
    const pos = t.sessionsCompleted % 4;
    for (let i = 0; i < 4; i++) {
      const d = document.createElement("div");
      d.className = "session-dot" + (i < pos ? " filled" : "");
      dots.appendChild(d);
    }
    document.getElementById("sessions-label").textContent = `${t.sessionsCompleted} session${t.sessionsCompleted !== 1 ? "s" : ""} completed`;
    syncTimerTick();
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
    buildDurationPresets(mode, minutes);
    document.getElementById("preset-bar").classList.remove("hidden");
  }
  function exitEditMode(save = true) {
    if (!isEditing) return;
    isEditing = false;
    if (save) {
      const raw = parseInt(document.getElementById("time-edit").value, 10);
      const min = isNaN(raw) ? null : Math.min(Math.max(raw, 1), 180);
      if (min) {
        const secs = min * 60;
        const mode = state?.timer.mode ?? "focus";
        send({
          type: "timerUpdateSettings",
          focusDuration: mode === "focus" ? secs : state?.timer.focusDuration,
          breakDuration: mode === "break" ? secs : state?.timer.breakDuration,
          longBreakDuration: mode === "longBreak" ? secs : state?.timer.longBreakDuration
        });
      }
    }
    document.getElementById("time-text").classList.remove("hidden");
    document.getElementById("time-editor").classList.add("hidden");
    document.getElementById("preset-bar").classList.add("hidden");
  }
  function buildDurationPresets(mode, current) {
    const bar = document.getElementById("preset-bar");
    bar.innerHTML = "";
    (DURATION_PRESETS[mode] ?? DURATION_PRESETS.focus).forEach((val) => {
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
  function updateShield() {
    const hasAlways = blockState.enabled && blockState.alwaysSites.length > 0;
    const hasFocus = blockState.enabled && blockState.focusSites.length > 0;
    const active = hasAlways || hasFocus;
    document.getElementById("shield-btn").classList.toggle("active", active);
    document.getElementById("shield-btn").classList.toggle("always-on", hasAlways);
  }
  function renderSiteList(listId, sites, onRemove, emptyText = "No sites.") {
    const list = document.getElementById(listId);
    list.innerHTML = "";
    if (!sites.length) {
      const empty = document.createElement("div");
      empty.className = "bp-empty";
      empty.textContent = emptyText;
      list.appendChild(empty);
      return;
    }
    [...sites].sort().forEach((site) => {
      const row = document.createElement("div");
      row.className = "bp-site-row";
      const dom = document.createElement("span");
      dom.className = "bp-site-domain";
      dom.textContent = site;
      const rm = document.createElement("button");
      rm.className = "bp-site-remove";
      rm.textContent = "\xD7";
      rm.addEventListener("click", () => onRemove(site));
      row.append(dom, rm);
      list.appendChild(row);
    });
  }
  function renderBlockPanel() {
    document.getElementById("block-enabled").checked = blockState.enabled;
    document.querySelectorAll(".bp-gate-chip").forEach(
      (el) => el.classList.toggle("active", el.dataset.gate === blockState.gate)
    );
    document.getElementById("bp-pw-row").classList.toggle("hidden", blockState.gate !== "password");
    const presets = blockState.presets ?? DEFAULT_PRESETS;
    document.querySelectorAll(".bp-preset").forEach((el) => {
      const key = el.dataset.preset;
      const isList = el.dataset.list;
      const preset = presets[key] ?? [];
      const sites = isList === "always" ? blockState.alwaysSites : blockState.focusSites;
      const n = preset.filter((s) => sites.includes(s)).length;
      el.classList.toggle("all-on", n === preset.length && preset.length > 0);
      el.classList.toggle("some-on", n > 0 && n < preset.length);
    });
    renderSiteList(
      "bp-always-list",
      blockState.alwaysSites,
      (site) => send({ type: "setAlwaysSites", sites: blockState.alwaysSites.filter((s) => s !== site) })
    );
    renderSiteList(
      "bp-focus-list",
      blockState.focusSites,
      (site) => send({ type: "setFocusSites", sites: blockState.focusSites.filter((s) => s !== site) })
    );
  }
  function togglePreset(key, list) {
    const preset = (blockState.presets ?? DEFAULT_PRESETS)[key] ?? [];
    const current = list === "always" ? blockState.alwaysSites : blockState.focusSites;
    const allOn = preset.length > 0 && preset.every((s) => current.includes(s));
    let next = [...current];
    if (allOn) next = next.filter((s) => !preset.includes(s));
    else preset.forEach((s) => {
      if (!next.includes(s)) next.push(s);
    });
    send({ type: list === "always" ? "setAlwaysSites" : "setFocusSites", sites: next });
  }
  function addSite(raw, list) {
    const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0];
    if (!domain) return false;
    const current = list === "always" ? blockState.alwaysSites : blockState.focusSites;
    if (current.includes(domain)) return false;
    send({ type: list === "always" ? "setAlwaysSites" : "setFocusSites", sites: [...current, domain] });
    return true;
  }
  function renderPresetEditor() {
    document.querySelectorAll(".pe-tab").forEach(
      (el) => el.classList.toggle("active", el.dataset.pt === currentPreset)
    );
    const presets = blockState.presets ?? DEFAULT_PRESETS;
    const sites = presets[currentPreset] ?? [];
    renderSiteList("pe-site-list", sites, (site) => {
      const updated = { ...presets, [currentPreset]: presets[currentPreset].filter((s) => s !== site) };
      send({ type: "setPresets", presets: updated });
    }, "No sites in this preset.");
  }
  function addToPreset(raw) {
    const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0];
    if (!domain) return false;
    const presets = blockState.presets ?? DEFAULT_PRESETS;
    const current = presets[currentPreset] ?? [];
    if (current.includes(domain)) return false;
    send({ type: "setPresets", presets: { ...presets, [currentPreset]: [...current, domain] } });
    return true;
  }
  function showPanel(id) {
    for (const panelId of ["timer-view", "block-panel", "preset-editor"]) {
      document.getElementById(panelId).classList.toggle("hidden", panelId !== id);
    }
  }
  function wire() {
    document.getElementById("shield-btn").addEventListener("click", () => showPanel("block-panel"));
    document.getElementById("block-back-btn").addEventListener("click", () => showPanel("timer-view"));
    document.getElementById("bp-edit-presets-btn").addEventListener("click", () => showPanel("preset-editor"));
    document.getElementById("preset-back-btn").addEventListener("click", () => showPanel("block-panel"));
    document.getElementById("time-text").addEventListener("click", enterEditMode);
    document.getElementById("time-edit").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        exitEditMode(true);
      }
      if (e.key === "Escape") exitEditMode(false);
    });
    document.getElementById("time-edit").addEventListener(
      "blur",
      () => setTimeout(() => {
        if (isEditing) exitEditMode(true);
      }, 150)
    );
    document.querySelectorAll(".mode-tab").forEach(
      (el) => el.addEventListener(
        "click",
        () => send({ type: "timerSetMode", mode: el.dataset.mode })
      )
    );
    document.getElementById("start-pause-btn").addEventListener("click", () => {
      if (!state) return;
      send({ type: state.timer.isRunning ? "timerPause" : "timerStart" });
    });
    document.getElementById("reset-btn").addEventListener("click", () => send({ type: "timerReset" }));
    document.getElementById("skip-btn").addEventListener("click", () => send({ type: "timerSkip" }));
    document.getElementById("add-min-btn").addEventListener("click", () => send({ type: "timerAddMinute" }));
    document.getElementById("block-enabled").addEventListener(
      "change",
      (e) => send({ type: "setBlockEnabled", enabled: e.target.checked })
    );
    document.querySelectorAll(".bp-gate-chip").forEach(
      (el) => el.addEventListener(
        "click",
        () => send({ type: "setBlockGate", gate: el.dataset.gate })
      )
    );
    document.getElementById("bp-pw-save").addEventListener("click", () => {
      const inp = document.getElementById("bp-pw-input");
      const pw = inp.value.trim();
      if (!pw) return;
      send({ type: "setBlockGate", gate: "password", password: pw });
      inp.value = "";
      const saved = document.getElementById("bp-pw-saved");
      saved.classList.remove("hidden");
      setTimeout(() => saved.classList.add("hidden"), 2e3);
    });
    document.getElementById("bp-pw-input").addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        document.getElementById("bp-pw-save").click();
      }
    });
    document.querySelectorAll(".bp-preset").forEach(
      (el) => el.addEventListener(
        "click",
        () => togglePreset(
          el.dataset.preset,
          el.dataset.list
        )
      )
    );
    document.getElementById("bp-always-add").addEventListener("click", () => {
      const inp = document.getElementById("bp-always-input");
      if (addSite(inp.value, "always")) inp.value = "";
    });
    document.getElementById("bp-always-input").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const inp = e.target;
      if (addSite(inp.value, "always")) inp.value = "";
    });
    document.getElementById("bp-focus-add").addEventListener("click", () => {
      const inp = document.getElementById("bp-focus-input");
      if (addSite(inp.value, "focus")) inp.value = "";
    });
    document.getElementById("bp-focus-input").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const inp = e.target;
      if (addSite(inp.value, "focus")) inp.value = "";
    });
    document.querySelectorAll(".pe-tab").forEach(
      (el) => el.addEventListener("click", () => {
        currentPreset = el.dataset.pt;
        renderPresetEditor();
      })
    );
    document.getElementById("pe-add-btn").addEventListener("click", () => {
      const inp = document.getElementById("pe-add-input");
      if (addToPreset(inp.value)) inp.value = "";
    });
    document.getElementById("pe-add-input").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const inp = e.target;
      if (addToPreset(inp.value)) inp.value = "";
    });
    document.getElementById("pe-reset-btn").addEventListener("click", () => {
      const presets = blockState.presets ?? DEFAULT_PRESETS;
      send({ type: "setPresets", presets: { ...presets, [currentPreset]: [...DEFAULT_PRESETS[currentPreset]] } });
    });
    document.getElementById("mute-btn").addEventListener("click", () => {
      soundEnabled = !soundEnabled;
      updateMuteBtn();
      send({ type: "setTimerSound", enabled: soundEnabled });
    });
    document.getElementById("settings-link")?.addEventListener(
      "click",
      () => browser.tabs.create({ url: browser.runtime.getURL("settings/settings.html") })
    );
  }
  wire();
  connect();
  applyTheme();
})();
