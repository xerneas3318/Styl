"use strict";
(() => {
  // src/shared/utils.ts
  function fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
  }

  // src/popup/index.ts
  var RING_C = 2 * Math.PI * 52;
  var BLOCK_PRESETS = {
    social: {
      label: "Social",
      sites: [
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
      ]
    },
    video: {
      label: "Video",
      sites: ["youtube.com", "netflix.com", "twitch.tv", "hulu.com", "disneyplus.com", "primevideo.com", "vimeo.com"]
    },
    news: {
      label: "News",
      sites: ["cnn.com", "bbc.com", "nytimes.com", "buzzfeed.com", "theguardian.com", "huffpost.com", "dailymail.co.uk"]
    }
  };
  var DURATION_PRESETS = {
    focus: [15, 20, 25, 30, 45, 60, 90],
    break: [5, 10, 15],
    longBreak: [10, 15, 20, 25, 30]
  };
  var port = null;
  var state = null;
  var blockState = { enabled: true, sites: [] };
  var isEditing = false;
  function connect() {
    port = browser.runtime.connect({ name: "popup" });
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "stateUpdate":
          state = msg.state;
          blockState = msg.state.blockState ?? blockState;
          render();
          renderBlockPanel();
          updateShield();
          if (msg.event === "timerComplete") playChime();
          break;
        case "blockStateUpdate":
          blockState = msg.blockState;
          renderBlockPanel();
          updateShield();
          break;
        case "aiThinking":
          setStatus("Thinking\u2026");
          break;
        case "aiComplete":
          setStatus(msg.message);
          break;
        case "error":
          setStatus(`\u26A0 ${msg.message}`);
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
      document.getElementById("time-text").textContent = fmt(t.pausedTimeRemaining);
    }
    const progress = t.sessionTotal > 0 ? t.pausedTimeRemaining / t.sessionTotal : 1;
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
    const active = blockState.enabled && blockState.sites.length > 0;
    document.getElementById("shield-btn").classList.toggle("active", active);
  }
  function renderBlockPanel() {
    document.getElementById("block-enabled").checked = blockState.enabled;
    document.querySelectorAll(".bp-preset").forEach((el) => {
      const preset = BLOCK_PRESETS[el.dataset.preset];
      if (!preset) return;
      const n = preset.sites.filter((s) => blockState.sites.includes(s)).length;
      el.classList.toggle("all-on", n === preset.sites.length);
      el.classList.toggle("some-on", n > 0 && n < preset.sites.length);
    });
    const list = document.getElementById("bp-site-list");
    list.innerHTML = "";
    if (!blockState.sites.length) {
      const empty = document.createElement("div");
      empty.className = "bp-empty";
      empty.textContent = "No sites blocked.";
      list.appendChild(empty);
      return;
    }
    [...blockState.sites].sort().forEach((site) => {
      const row = document.createElement("div");
      row.className = "bp-site-row";
      const dom = document.createElement("span");
      dom.className = "bp-site-domain";
      dom.textContent = site;
      const rm = document.createElement("button");
      rm.className = "bp-site-remove";
      rm.textContent = "\xD7";
      rm.addEventListener(
        "click",
        () => send({ type: "setBlockedSites", sites: blockState.sites.filter((s) => s !== site) })
      );
      row.append(dom, rm);
      list.appendChild(row);
    });
  }
  function togglePreset(key) {
    const preset = BLOCK_PRESETS[key];
    if (!preset) return;
    const allOn = preset.sites.every((s) => blockState.sites.includes(s));
    let next = [...blockState.sites];
    if (allOn) next = next.filter((s) => !preset.sites.includes(s));
    else preset.sites.forEach((s) => {
      if (!next.includes(s)) next.push(s);
    });
    send({ type: "setBlockedSites", sites: next });
  }
  function addCustomSite(raw) {
    const domain = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0].split("?")[0];
    if (!domain || blockState.sites.includes(domain)) return false;
    send({ type: "setBlockedSites", sites: [...blockState.sites, domain] });
    return true;
  }
  function setStatus(msg) {
    const el = document.getElementById("ai-status");
    if (!el) return;
    el.textContent = msg;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 5e3);
  }
  function wire() {
    document.getElementById("shield-btn").addEventListener("click", () => {
      document.getElementById("timer-view").classList.add("hidden");
      document.getElementById("block-panel").classList.remove("hidden");
    });
    document.getElementById("block-back-btn").addEventListener("click", () => {
      document.getElementById("block-panel").classList.add("hidden");
      document.getElementById("timer-view").classList.remove("hidden");
    });
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
    document.querySelectorAll(".bp-preset").forEach(
      (el) => el.addEventListener("click", () => togglePreset(el.dataset.preset))
    );
    document.getElementById("bp-add-btn").addEventListener("click", () => {
      const inp = document.getElementById("bp-add-input");
      if (addCustomSite(inp.value)) inp.value = "";
    });
    document.getElementById("bp-add-input").addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      const inp = e.target;
      if (addCustomSite(inp.value)) inp.value = "";
    });
    document.getElementById("settings-link")?.addEventListener(
      "click",
      () => browser.tabs.create({ url: browser.runtime.getURL("settings/settings.html") })
    );
  }
  wire();
  connect();
})();
//# sourceMappingURL=popup.js.map
