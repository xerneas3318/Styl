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

  // src/shared/utils.ts
  function todayStr() {
    return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  }

  // src/background/github.ts
  var GITHUB_API = "https://api.github.com";
  function defaultMemory() {
    return {
      preferences: {},
      recurring_events: [],
      habits: [],
      task_patterns: {},
      known_entities: {}
    };
  }
  var GitHubClient = class {
    constructor(cfg) {
      this.cfg = cfg;
      // ── Domain helpers ─────────────────────────────────────────────────────────
      this.readTasks = () => this.readJSON("tasks.json", []);
      this.readMemory = () => this.readJSON("memory.json", defaultMemory());
      this.writeTasks = (tasks, msg) => this.writeJSON("tasks.json", tasks, msg);
      this.writeMemory = (memory, msg) => this.writeJSON("memory.json", memory, msg);
      this.saveSnapshot = (snap) => this.writeJSON(`snapshots/snapshot-${snap.id}.json`, snap, `snapshot: ${snap.id}`);
      this.saveDiff = (id, d) => this.writeJSON(`diffs/diff-${id}.json`, d, `diff: ${id}`);
    }
    get headers() {
      return {
        Authorization: `Bearer ${this.cfg.token}`,
        Accept: "application/vnd.github+json",
        "Content-Type": "application/json",
        "X-GitHub-Api-Version": "2022-11-28"
      };
    }
    url(path) {
      return `${GITHUB_API}/repos/${this.cfg.owner}/${this.cfg.repo}${path}`;
    }
    async req(method, path, body) {
      const res = await fetch(this.url(path), {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : void 0
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`GitHub ${method} ${path} \u2192 ${res.status}: ${text}`);
      }
      return res.json();
    }
    async getFile(path) {
      try {
        const data = await this.req(
          "GET",
          `/contents/${path}?ref=${this.cfg.branch}`
        );
        return {
          content: decodeURIComponent(escape(atob(data.content.replace(/\n/g, "")))),
          sha: data.sha
        };
      } catch {
        return null;
      }
    }
    async putFile(path, content, message, sha) {
      await this.req("PUT", `/contents/${path}`, {
        message,
        content: btoa(unescape(encodeURIComponent(content))),
        branch: this.cfg.branch,
        ...sha ? { sha } : {}
      });
    }
    async readJSON(path, fallback) {
      const file = await this.getFile(path);
      if (!file) return fallback;
      try {
        return JSON.parse(file.content);
      } catch {
        return fallback;
      }
    }
    async writeJSON(path, data, message) {
      const file = await this.getFile(path);
      await this.putFile(path, JSON.stringify(data, null, 2), message, file?.sha);
    }
    async appendLog(entry) {
      const path = `logs/${todayStr()}.json`;
      const file = await this.getFile(path);
      const prev = file ? JSON.parse(file.content) : [];
      prev.push(entry);
      await this.putFile(path, JSON.stringify(prev, null, 2), `log: ${entry.timestamp}`, file?.sha);
    }
    async testConnection() {
      try {
        await this.req("GET", "");
        return { ok: true };
      } catch (e) {
        return { ok: false, error: e.message };
      }
    }
    async bootstrap() {
      const [tasks, memory] = await Promise.all([
        this.getFile("tasks.json"),
        this.getFile("memory.json")
      ]);
      const writes = [];
      if (!tasks) writes.push(this.putFile("tasks.json", "[]", "init: tasks"));
      if (!memory) writes.push(this.putFile("memory.json", JSON.stringify(defaultMemory(), null, 2), "init: memory"));
      await Promise.all(writes);
    }
  };

  // src/settings/index.ts
  var settings = {
    github: null,
    ai: null,
    google: null,
    autoApproveAI: false,
    focusDuration: 25 * 60,
    breakDuration: 5 * 60,
    longBreakDuration: 15 * 60
  };
  async function init() {
    const saved = await Storage.getSettings();
    if (saved) settings = saved;
    populateForm();
  }
  function populateForm() {
    setVal("gh-owner", settings.github?.owner ?? "");
    setVal("gh-repo", settings.github?.repo ?? "");
    setVal("gh-token", settings.github?.token ?? "");
    setVal("gh-branch", settings.github?.branch ?? "main");
    setVal("ai-provider", settings.ai?.provider ?? "anthropic");
    setVal("ai-key", settings.ai?.apiKey ?? "");
    setVal("ai-model", settings.ai?.model ?? "");
    updateModelPlaceholder();
    setCheck("auto-approve", settings.autoApproveAI);
    setVal("focus-dur", String(Math.round((settings.focusDuration ?? 25 * 60) / 60)));
    setVal("break-dur", String(Math.round((settings.breakDuration ?? 5 * 60) / 60)));
    setVal("long-break-dur", String(Math.round((settings.longBreakDuration ?? 15 * 60) / 60)));
    const gStatus = document.getElementById("google-status");
    const tok = settings.google?.accessToken;
    gStatus.textContent = tok ? `Token set (${tok.slice(0, 8)}\u2026)` : "Not connected";
    setVal("google-token", "");
  }
  function collectSettings() {
    const provider = getVal("ai-provider");
    return {
      github: {
        owner: getVal("gh-owner"),
        repo: getVal("gh-repo"),
        token: getVal("gh-token"),
        branch: getVal("gh-branch") || "main"
      },
      ai: {
        provider,
        apiKey: getVal("ai-key"),
        model: getVal("ai-model") || defaultModel(provider)
      },
      google: collectGoogle(),
      autoApproveAI: getCheck("auto-approve"),
      focusDuration: parseInt(getVal("focus-dur"), 10) * 60 || 25 * 60,
      breakDuration: parseInt(getVal("break-dur"), 10) * 60 || 5 * 60,
      longBreakDuration: parseInt(getVal("long-break-dur"), 10) * 60 || 15 * 60
    };
  }
  async function save() {
    settings = collectSettings();
    await Storage.setSettings(settings);
    try {
      const port = browser.runtime.connect({ name: "settings" });
      port.postMessage({ type: "settingsUpdated", settings });
      port.disconnect();
    } catch {
    }
    showStatus("Saved.", false);
  }
  async function testGitHub() {
    const cfg = {
      owner: getVal("gh-owner"),
      repo: getVal("gh-repo"),
      token: getVal("gh-token"),
      branch: getVal("gh-branch") || "main"
    };
    if (!cfg.owner || !cfg.repo || !cfg.token) {
      showStatus("Fill in all GitHub fields first.", true);
      return;
    }
    showStatus("Testing\u2026", false);
    const gh = new GitHubClient(cfg);
    const { ok, error } = await gh.testConnection();
    if (ok) {
      showStatus("GitHub connected!", false);
      await gh.bootstrap();
    } else {
      showStatus(`GitHub error: ${error ?? "unknown"}`, true);
    }
  }
  function collectGoogle() {
    const raw = getVal("google-token");
    if (raw) {
      return {
        accessToken: raw,
        tokenExpiry: Date.now() + 3600 * 1e3,
        // assume 1h; refresh when expired
        gmailEnabled: true,
        calendarEnabled: true
      };
    }
    return settings.google ?? null;
  }
  function disconnectGoogle() {
    settings.google = null;
    setVal("google-token", "");
    Storage.setSettings(settings).then(() => {
      populateForm();
      showStatus("Google token cleared.", false);
    });
  }
  async function loadSnapshots() {
    const snaps = await Storage.getSnapshots();
    const list = document.getElementById("snapshot-list");
    list.innerHTML = "";
    if (!snaps.length) {
      list.innerHTML = '<div class="snap-empty">No snapshots yet.</div>';
      return;
    }
    snaps.slice(0, 20).forEach((snap) => {
      const row = document.createElement("div");
      row.className = "snap-row";
      const ts = document.createElement("span");
      ts.className = "snap-ts";
      ts.textContent = new Date(snap.timestamp).toLocaleString();
      const info = document.createElement("span");
      info.className = "snap-info";
      info.textContent = `${snap.tasks.length} task${snap.tasks.length !== 1 ? "s" : ""}`;
      const revert = document.createElement("button");
      revert.className = "snap-revert";
      revert.textContent = "Revert";
      revert.addEventListener("click", () => {
        if (!confirm(`Revert to snapshot from ${new Date(snap.timestamp).toLocaleString()}?`)) return;
        const port = browser.runtime.connect({ name: "settings" });
        port.postMessage({ type: "revertToSnapshot", snapshotId: snap.id });
        port.disconnect();
        showStatus("Reverted.", false);
      });
      row.append(ts, info, revert);
      list.appendChild(row);
    });
  }
  function getVal(id) {
    return document.getElementById(id).value.trim();
  }
  function setVal(id, v) {
    document.getElementById(id).value = v;
  }
  function getCheck(id) {
    return document.getElementById(id).checked;
  }
  function setCheck(id, v) {
    document.getElementById(id).checked = v;
  }
  function showStatus(msg, isError) {
    const el = document.getElementById("status-msg");
    el.textContent = msg;
    el.className = `status-msg ${isError ? "error" : "ok"}`;
    el.classList.remove("hidden");
    setTimeout(() => el.classList.add("hidden"), 4e3);
  }
  function defaultModel(provider) {
    return provider === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini";
  }
  function updateModelPlaceholder() {
    const provider = getVal("ai-provider");
    const input = document.getElementById("ai-model");
    input.placeholder = defaultModel(provider);
  }
  function initTabs() {
    document.querySelectorAll(".tab-btn").forEach((btn) => {
      btn.addEventListener("click", () => {
        const target = btn.dataset.tab;
        document.querySelectorAll(".tab-btn").forEach((b) => b.classList.remove("active"));
        document.querySelectorAll(".tab-panel").forEach((p) => p.classList.add("hidden"));
        btn.classList.add("active");
        document.getElementById(`tab-${target}`).classList.remove("hidden");
        if (target === "history") loadSnapshots();
      });
    });
  }
  document.getElementById("save-btn").addEventListener("click", save);
  document.getElementById("test-github-btn").addEventListener("click", testGitHub);
  document.getElementById("disconnect-google-btn").addEventListener("click", disconnectGoogle);
  document.getElementById("ai-provider").addEventListener("change", updateModelPlaceholder);
  initTabs();
  init();
})();
//# sourceMappingURL=settings.js.map
