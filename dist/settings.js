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
  var ghPollTimer = null;
  async function init() {
    const saved = await Storage.getSettings();
    if (saved) settings = saved;
    populateForm();
    showRedirectUri();
  }
  function populateForm() {
    if (settings.github?.clientId) {
      setVal("gh-client-id", settings.github.clientId);
    }
    setVal("gh-branch", settings.github?.branch ?? "main");
    updateGitHubUI();
    setVal("ai-provider", settings.ai?.provider ?? "anthropic");
    setVal("ai-key", settings.ai?.apiKey ?? "");
    setVal("ai-model", settings.ai?.model ?? "");
    updateModelPlaceholder();
    setCheck("auto-approve", settings.autoApproveAI);
    setVal("focus-dur", String(Math.round((settings.focusDuration ?? 25 * 60) / 60)));
    setVal("break-dur", String(Math.round((settings.breakDuration ?? 5 * 60) / 60)));
    setVal("long-break-dur", String(Math.round((settings.longBreakDuration ?? 15 * 60) / 60)));
    if (settings.google?.clientId) setVal("google-client-id", settings.google.clientId);
    updateGoogleUI();
  }
  function updateGitHubUI() {
    const connected = document.getElementById("github-connected");
    const disconnected = document.getElementById("github-disconnected");
    if (settings.github?.token && settings.github?.owner) {
      connected.classList.remove("hidden");
      disconnected.classList.add("hidden");
      document.getElementById("github-account-label").textContent = `@${settings.github.owner}`;
      document.getElementById("github-account-sub").textContent = settings.github.repo ? `/${settings.github.repo}` : "No repo selected";
      setVal("gh-branch", settings.github.branch || "main");
      populateRepoSelect(settings.github.owner, settings.github.token);
    } else {
      connected.classList.add("hidden");
      disconnected.classList.remove("hidden");
      updateGitHubButtonState();
    }
  }
  function updateGitHubButtonState() {
    const btn = document.getElementById("connect-github-btn");
    btn.disabled = !getVal("gh-client-id");
  }
  async function connectGitHub() {
    const clientId = getVal("gh-client-id");
    if (!clientId) {
      showStatus("Enter your GitHub OAuth App Client ID first.", true);
      return;
    }
    showStatus("Requesting device code\u2026", false);
    let codeData;
    try {
      const res = await fetch("https://github.com/login/device/code", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({ client_id: clientId, scope: "repo" })
      });
      codeData = await res.json();
    } catch (e) {
      showStatus(`Failed to reach GitHub: ${e.message}`, true);
      return;
    }
    if (codeData.error) {
      showStatus(`GitHub error: ${codeData.error}`, true);
      return;
    }
    document.getElementById("gh-device-code").textContent = codeData.user_code;
    document.getElementById("gh-device-prompt").classList.remove("hidden");
    document.getElementById("connect-github-btn").disabled = true;
    window.open(codeData.verification_uri, "_blank");
    const interval = (codeData.interval ?? 5) * 1e3;
    const expiresAt = Date.now() + (codeData.expires_in ?? 900) * 1e3;
    const poll = async () => {
      if (Date.now() > expiresAt) {
        showStatus("Code expired \u2014 try again.", true);
        resetDevicePrompt();
        return;
      }
      let tokenData;
      try {
        const res = await fetch("https://github.com/login/oauth/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({
            client_id: clientId,
            device_code: codeData.device_code,
            grant_type: "urn:ietf:params:oauth:grant-type:device_code"
          })
        });
        tokenData = await res.json();
      } catch {
        ghPollTimer = setTimeout(poll, interval);
        return;
      }
      if (tokenData.access_token) {
        resetDevicePrompt();
        await onGitHubToken(clientId, tokenData.access_token);
      } else if (tokenData.error === "authorization_pending" || tokenData.error === "slow_down") {
        ghPollTimer = setTimeout(poll, tokenData.error === "slow_down" ? interval + 5e3 : interval);
      } else {
        showStatus(`GitHub auth failed: ${tokenData.error_description ?? tokenData.error}`, true);
        resetDevicePrompt();
      }
    };
    ghPollTimer = setTimeout(poll, interval);
  }
  function resetDevicePrompt() {
    document.getElementById("gh-device-prompt").classList.add("hidden");
    document.getElementById("connect-github-btn").disabled = false;
    if (ghPollTimer) {
      clearTimeout(ghPollTimer);
      ghPollTimer = null;
    }
  }
  async function onGitHubToken(clientId, token) {
    let username = "";
    try {
      const res = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const u = await res.json();
      username = u.login;
    } catch {
      showStatus("Connected but could not fetch username.", true);
      return;
    }
    settings.github = {
      owner: username,
      repo: settings.github?.repo ?? "",
      branch: settings.github?.branch ?? "main",
      token,
      clientId
    };
    await Storage.setSettings(settings);
    notifyBackground();
    updateGitHubUI();
    showStatus(`Connected as @${username}!`, false);
  }
  async function populateRepoSelect(owner, token) {
    const select = document.getElementById("gh-repo-select");
    select.innerHTML = '<option value="">Loading\u2026</option>';
    try {
      const res = await fetch("https://api.github.com/user/repos?per_page=100&sort=updated", {
        headers: { Authorization: `Bearer ${token}` }
      });
      const repos = await res.json();
      select.innerHTML = '<option value="">\u2014 pick a repository \u2014</option>';
      repos.forEach((r) => {
        const opt = document.createElement("option");
        opt.value = r.name;
        opt.textContent = `${owner}/${r.name}${r.private ? " \u{1F512}" : ""}`;
        if (r.name === settings.github?.repo) opt.selected = true;
        select.appendChild(opt);
      });
    } catch {
      select.innerHTML = '<option value="">Could not load repos</option>';
    }
  }
  async function disconnectGitHub() {
    if (ghPollTimer) {
      clearTimeout(ghPollTimer);
      ghPollTimer = null;
    }
    settings.github = null;
    await Storage.setSettings(settings);
    notifyBackground();
    updateGitHubUI();
    showStatus("GitHub disconnected.", false);
  }
  async function testGitHub() {
    if (!settings.github?.token || !settings.github?.repo) {
      showStatus("Connect GitHub and pick a repo first.", true);
      return;
    }
    showStatus("Testing\u2026", false);
    const gh = new GitHubClient(settings.github);
    const { ok, error } = await gh.testConnection();
    if (ok) {
      showStatus("GitHub connected! Bootstrapping repo\u2026", false);
      await gh.bootstrap();
      showStatus("GitHub ready.", false);
    } else {
      showStatus(`GitHub error: ${error ?? "unknown"}`, true);
    }
  }
  function showRedirectUri() {
    try {
      const uri = browser.identity.getRedirectURL();
      document.getElementById("redirect-uri-display").textContent = uri;
    } catch {
      document.getElementById("redirect-uri-display").textContent = "browser.identity not available";
    }
  }
  function updateGoogleUI() {
    const connected = document.getElementById("google-connected");
    const disconnected = document.getElementById("google-disconnected");
    const sub = document.getElementById("google-account-sub");
    if (settings.google?.accessToken) {
      connected.classList.remove("hidden");
      disconnected.classList.add("hidden");
      const services = [
        settings.google.gmailEnabled ? "Gmail" : null,
        settings.google.calendarEnabled ? "Calendar" : null
      ].filter(Boolean).join(" + ");
      sub.textContent = `${services || "No services"} active`;
    } else {
      connected.classList.add("hidden");
      disconnected.classList.remove("hidden");
      updateGoogleButtonState();
    }
  }
  function updateGoogleButtonState() {
    const btn = document.getElementById("connect-google-btn");
    const id = getVal("google-client-id");
    const sec = getVal("google-client-secret");
    btn.disabled = !(id && sec);
  }
  async function connectGoogle() {
    const clientId = getVal("google-client-id");
    const clientSecret = getVal("google-client-secret");
    if (!clientId || !clientSecret) {
      showStatus("Enter Client ID and Client Secret first.", true);
      return;
    }
    const redirectUri = browser.identity.getRedirectURL();
    const authUrl = "https://accounts.google.com/o/oauth2/v2/auth?" + new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: "code",
      scope: [
        "https://www.googleapis.com/auth/gmail.readonly",
        "https://www.googleapis.com/auth/calendar"
      ].join(" "),
      access_type: "offline",
      prompt: "consent"
    }).toString();
    let redirectUrl;
    try {
      redirectUrl = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
    } catch (e) {
      showStatus(`Sign-in cancelled: ${e.message}`, true);
      return;
    }
    const code = new URL(redirectUrl).searchParams.get("code");
    if (!code) {
      showStatus("No authorization code returned.", true);
      return;
    }
    showStatus("Connecting\u2026", false);
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          code,
          client_id: clientId,
          client_secret: clientSecret,
          redirect_uri: redirectUri,
          grant_type: "authorization_code"
        }).toString()
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error_description ?? data.error);
      if (!data.access_token) throw new Error("No access token in response");
      settings.google = {
        clientId,
        clientSecret,
        accessToken: data.access_token,
        refreshToken: data.refresh_token,
        tokenExpiry: Date.now() + (data.expires_in ?? 3600) * 1e3,
        gmailEnabled: true,
        calendarEnabled: true
      };
      await Storage.setSettings(settings);
      notifyBackground();
      updateGoogleUI();
      showStatus("Google connected!", false);
    } catch (e) {
      showStatus(`Token exchange failed: ${e.message}`, true);
    }
  }
  function disconnectGoogle() {
    settings.google = null;
    Storage.setSettings(settings).then(() => {
      notifyBackground();
      updateGoogleUI();
      showStatus("Google disconnected.", false);
    });
  }
  function collectSettings() {
    const provider = getVal("ai-provider");
    return {
      // GitHub is managed by the OAuth flow — only sync branch from the form
      github: settings.github ? { ...settings.github, branch: getVal("gh-branch") || "main" } : null,
      ai: {
        provider,
        apiKey: getVal("ai-key"),
        model: getVal("ai-model") || defaultModel(provider)
      },
      // Google is managed by the OAuth flow
      google: settings.google,
      autoApproveAI: getCheck("auto-approve"),
      focusDuration: parseInt(getVal("focus-dur"), 10) * 60 || 25 * 60,
      breakDuration: parseInt(getVal("break-dur"), 10) * 60 || 5 * 60,
      longBreakDuration: parseInt(getVal("long-break-dur"), 10) * 60 || 15 * 60
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
        if (!confirm(`Revert to ${new Date(snap.timestamp).toLocaleString()}?`)) return;
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
    setTimeout(() => el.classList.add("hidden"), 5e3);
  }
  function defaultModel(provider) {
    return provider === "anthropic" ? "claude-haiku-4-5-20251001" : "gpt-4o-mini";
  }
  function updateModelPlaceholder() {
    const provider = getVal("ai-provider");
    document.getElementById("ai-model").placeholder = defaultModel(provider);
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
  document.getElementById("connect-github-btn").addEventListener("click", connectGitHub);
  document.getElementById("disconnect-github-btn").addEventListener("click", disconnectGitHub);
  document.getElementById("test-github-btn").addEventListener("click", testGitHub);
  document.getElementById("gh-client-id").addEventListener("input", updateGitHubButtonState);
  document.getElementById("copy-device-code").addEventListener("click", () => {
    const code = document.getElementById("gh-device-code").textContent ?? "";
    navigator.clipboard.writeText(code).then(() => showStatus("Code copied!", false));
  });
  document.getElementById("gh-repo-select").addEventListener("change", async () => {
    if (!settings.github) return;
    const repo = document.getElementById("gh-repo-select").value;
    settings.github = { ...settings.github, repo };
    await Storage.setSettings(settings);
    notifyBackground();
    document.getElementById("github-account-sub").textContent = repo ? `/${repo}` : "No repo selected";
    if (repo) showStatus(`Repo set to ${settings.github.owner}/${repo}.`, false);
  });
  document.getElementById("gh-branch").addEventListener("change", async () => {
    if (!settings.github) return;
    settings.github = { ...settings.github, branch: getVal("gh-branch") || "main" };
    await Storage.setSettings(settings);
    notifyBackground();
  });
  document.getElementById("connect-google-btn").addEventListener("click", connectGoogle);
  document.getElementById("disconnect-google-btn").addEventListener("click", disconnectGoogle);
  document.getElementById("copy-redirect-uri").addEventListener("click", () => {
    const uri = document.getElementById("redirect-uri-display").textContent ?? "";
    navigator.clipboard.writeText(uri).then(() => showStatus("Copied!", false));
  });
  document.getElementById("google-client-id").addEventListener("input", updateGoogleButtonState);
  document.getElementById("google-client-secret").addEventListener("input", updateGoogleButtonState);
  document.getElementById("save-btn").addEventListener("click", save);
  document.getElementById("ai-provider").addEventListener("change", updateModelPlaceholder);
  initTabs();
  init();
})();
//# sourceMappingURL=settings.js.map
