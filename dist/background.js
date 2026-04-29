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
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function isoNow() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function todayStr() {
    return (/* @__PURE__ */ new Date()).toISOString().slice(0, 10);
  }
  function clone(v) {
    return JSON.parse(JSON.stringify(v));
  }

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
    /** Creates the repo if it doesn't already exist (422 = already exists → fine). */
    async createRepo(name) {
      const res = await fetch(`${GITHUB_API}/user/repos`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28"
        },
        body: JSON.stringify({
          name,
          private: true,
          description: "Styl browser extension data",
          auto_init: true
          // creates an initial commit so the branch exists
        })
      });
      if (!res.ok && res.status !== 422) {
        const data = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(data.message ?? "Could not create repo");
      }
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

  // src/background/ai.ts
  var SYSTEM_PROMPT = `You are a deterministic personal planning assistant embedded in a browser extension.
You manage tasks, memory, and calendar. Return ONLY valid JSON \u2014 no markdown, no prose wrappers.

Output schema:
{
  "message": "1-2 line confirmation (terse)",
  "actions": [ ...AIAction ],
  "requiresApproval": false
}

Action types and their payload shapes:
  create_task        { title, status?, priority?, estimated_duration_minutes?, due_date?, project?, source?, notes? }
  update_task        { id, ...fields }
  delete_task        { id }
  reorder_tasks      { orderedIds: string[] }
  plan_day           { orderedTasks: Array<{ id, estimated_duration_minutes? }> }
  update_memory      { path: "dot.separated.key", value: any }
  create_calendar_event { title, start (ISO), end (ISO), description? }

Rules:
- requiresApproval = true only for bulk deletes or explicit destructive rewrites
- Tasks are flexible work. Calendar events are fixed-time appointments only.
- Infer priority from urgency language: "urgent/asap/due today" \u2192 high, "sometime" \u2192 low
- When asked to "plan my day", reorder todo tasks by priority+duration fit, fill in durations
- "mark X done" \u2192 update_task with status:"done"
- Extract tasks from screenshot text literally \u2014 preserve exact wording`;
  var AIClient = class {
    constructor(cfg) {
      this.cfg = cfg;
    }
    async sendCommand(prompt, tasks, memory, calendar, imageData) {
      const context = buildContext(tasks, memory, calendar);
      return this.cfg.provider === "anthropic" ? this.callAnthropic(prompt, context, imageData) : this.callOpenAI(prompt, context, imageData);
    }
    async callAnthropic(prompt, context, imageData) {
      const content = [];
      if (imageData) {
        content.push({
          type: "image",
          source: { type: "base64", media_type: "image/png", data: imageData }
        });
      }
      content.push({ type: "text", text: `${context}

User: ${prompt}` });
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": this.cfg.apiKey,
          "anthropic-version": "2023-06-01",
          "content-type": "application/json"
        },
        body: JSON.stringify({
          model: this.cfg.model || "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          system: SYSTEM_PROMPT,
          messages: [{ role: "user", content }]
        })
      });
      if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return parseAIResponse(data.content[0].text);
    }
    async callOpenAI(prompt, context, imageData) {
      const userContent = [];
      if (imageData) {
        userContent.push({
          type: "image_url",
          image_url: { url: `data:image/png;base64,${imageData}` }
        });
      }
      userContent.push({ type: "text", text: `${context}

User: ${prompt}` });
      const res = await fetch("https://api.openai.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.cfg.apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: this.cfg.model || "gpt-4o-mini",
          messages: [
            { role: "system", content: SYSTEM_PROMPT },
            { role: "user", content: userContent }
          ],
          max_tokens: 2048,
          response_format: { type: "json_object" }
        })
      });
      if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
      const data = await res.json();
      return parseAIResponse(data.choices[0].message.content);
    }
  };
  function applyActions(tasks, memory, actions) {
    let newTasks = [...tasks];
    const newMem = JSON.parse(JSON.stringify(memory));
    const calReqs = [];
    for (const rawAction of actions) {
      const action = {
        ...rawAction,
        type: rawAction.type.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/-/g, "_")
      };
      switch (action.type) {
        case "create_task": {
          const p = action.payload;
          newTasks.push({
            id: generateId(),
            title: p.title ?? "Untitled",
            status: p.status ?? "todo",
            priority: p.priority ?? "medium",
            source: p.source ?? "ai",
            estimated_duration_minutes: p.estimated_duration_minutes,
            due_date: p.due_date,
            project: p.project,
            notes: p.notes,
            created_at: isoNow(),
            updated_at: isoNow()
          });
          break;
        }
        case "update_task": {
          const p = action.payload;
          newTasks = newTasks.map(
            (t) => t.id === p.id ? { ...t, ...p, updated_at: isoNow() } : t
          );
          break;
        }
        case "delete_task": {
          const { id } = action.payload;
          newTasks = newTasks.filter((t) => t.id !== id);
          break;
        }
        case "reorder_tasks": {
          const { orderedIds } = action.payload;
          const map = new Map(newTasks.map((t) => [t.id, t]));
          newTasks = orderedIds.map((id) => map.get(id)).filter(Boolean);
          break;
        }
        case "plan_day": {
          const { orderedTasks } = action.payload;
          const idxMap = new Map(orderedTasks.map((t, i) => [t.id, i]));
          const durMap = new Map(
            orderedTasks.filter((t) => t.estimated_duration_minutes != null).map((t) => [t.id, t.estimated_duration_minutes])
          );
          newTasks = [...newTasks].sort(
            (a, b) => (idxMap.get(a.id) ?? 999) - (idxMap.get(b.id) ?? 999)
          );
          newTasks = newTasks.map(
            (t) => durMap.has(t.id) ? { ...t, estimated_duration_minutes: durMap.get(t.id), updated_at: isoNow() } : t
          );
          break;
        }
        case "update_memory": {
          const { path, value } = action.payload;
          setNested(newMem, path, value);
          break;
        }
        case "create_calendar_event": {
          calReqs.push(action.payload);
          break;
        }
      }
    }
    return { tasks: newTasks, memory: newMem, calendarRequests: calReqs };
  }
  function buildContext(tasks, memory, calendar) {
    return [
      `Tasks (${tasks.length}):
${JSON.stringify(tasks, null, 2)}`,
      `Memory:
${JSON.stringify(memory, null, 2)}`,
      `Today's calendar (${calendar.length} events):
${JSON.stringify(calendar, null, 2)}`
    ].join("\n\n");
  }
  function parseAIResponse(raw) {
    const cleaned = raw.replace(/^```json\s*/i, "").replace(/```\s*$/, "").trim();
    try {
      const parsed = JSON.parse(cleaned);
      return {
        message: String(parsed.message ?? ""),
        actions: Array.isArray(parsed.actions) ? parsed.actions : [],
        requiresApproval: parsed.requiresApproval === true
      };
    } catch {
      return { message: raw.slice(0, 200), actions: [], requiresApproval: false };
    }
  }
  function setNested(obj, path, value) {
    const parts = path.split(".");
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== "object") cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  // src/background/version-control.ts
  function createSnapshot(tasks, memory) {
    return {
      id: generateId(),
      timestamp: isoNow(),
      tasks: JSON.parse(JSON.stringify(tasks)),
      memory: JSON.parse(JSON.stringify(memory))
    };
  }
  function computeDiff(before, after) {
    const beforeMap = new Map(before.map((t) => [t.id, t]));
    const afterMap = new Map(after.map((t) => [t.id, t]));
    return {
      added: after.filter((t) => !beforeMap.has(t.id)),
      removed: before.filter((t) => !afterMap.has(t.id)),
      modified: after.filter((t) => beforeMap.has(t.id) && JSON.stringify(beforeMap.get(t.id)) !== JSON.stringify(t)).map((t) => ({ before: beforeMap.get(t.id), after: t }))
    };
  }
  function isDiffEmpty(diff) {
    return diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0;
  }
  async function commitChange(gh, beforeTasks, afterTasks, memory, prompt, actionTypes) {
    const snapshot = createSnapshot(afterTasks, memory);
    const diff = computeDiff(beforeTasks, afterTasks);
    await Storage.pushSnapshot(snapshot);
    const commitMsg = `ai: ${prompt.slice(0, 72)}`;
    const log = {
      timestamp: isoNow(),
      user_prompt: prompt,
      ai_actions_taken: actionTypes,
      files_changed: ["tasks.json", "memory.json"]
    };
    Promise.all([
      gh.writeTasks(afterTasks, commitMsg),
      gh.writeMemory(memory, commitMsg),
      gh.saveSnapshot(snapshot),
      !isDiffEmpty(diff) ? gh.saveDiff(snapshot.id, diff) : Promise.resolve(),
      gh.appendLog(log)
    ]).catch((e) => console.error("[styl] GitHub sync error:", e));
  }

  // src/background/gmail.ts
  var GmailClient = class {
    constructor(accessToken) {
      this.accessToken = accessToken;
    }
    get auth() {
      return { Authorization: `Bearer ${this.accessToken}` };
    }
    async getRecentUnread(max = 20) {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=is:unread`,
        { headers: this.auth }
      );
      if (!res.ok) throw new Error(`Gmail list error ${res.status}`);
      const list = await res.json();
      if (!list.messages?.length) return [];
      const results = await Promise.allSettled(
        list.messages.slice(0, max).map((m) => this.fetchMessage(m.id))
      );
      return results.filter((r) => r.status === "fulfilled").map((r) => r.value).filter((m) => m !== null);
    }
    async fetchMessage(id) {
      try {
        const res = await fetch(
          `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
          { headers: this.auth }
        );
        if (!res.ok) return null;
        const data = await res.json();
        const h = (name) => data.payload.headers.find((hh) => hh.name === name)?.value ?? "";
        return { id: data.id, subject: h("Subject"), from: h("From"), snippet: data.snippet, date: h("Date") };
      } catch {
        return null;
      }
    }
  };

  // src/background/calendar.ts
  var CalendarClient = class {
    constructor(accessToken) {
      this.accessToken = accessToken;
    }
    get auth() {
      return { Authorization: `Bearer ${this.accessToken}` };
    }
    async getTodayEvents() {
      const start = /* @__PURE__ */ new Date();
      start.setHours(0, 0, 0, 0);
      const end = new Date(start);
      end.setDate(start.getDate() + 1);
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        orderBy: "startTime"
      });
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
        { headers: this.auth }
      );
      if (!res.ok) throw new Error(`Calendar list error ${res.status}`);
      const data = await res.json();
      return (data.items ?? []).map((e) => ({
        id: e.id,
        title: e.summary ?? "(no title)",
        start: e.start.dateTime ?? e.start.date ?? "",
        end: e.end.dateTime ?? e.end.date ?? "",
        description: e.description
      }));
    }
    async createEvent(event) {
      const res = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        {
          method: "POST",
          headers: { ...this.auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: event.title,
            description: event.description,
            start: { dateTime: event.start },
            end: { dateTime: event.end }
          })
        }
      );
      if (!res.ok) throw new Error(`Calendar create error ${res.status}`);
    }
  };

  // src/background/index.ts
  var appState = {
    tasks: [],
    memory: defaultMemory2(),
    calendarCache: [],
    timer: defaultTimerState(),
    blockState: { enabled: true, sites: [] },
    lastSyncedAt: null
  };
  var settings = {
    github: null,
    ai: null,
    google: null,
    autoApproveAI: false,
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
    if (settings.github) {
      syncFromGitHub().catch((e) => console.warn("[styl] boot sync:", e));
    }
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
      broadcast({ type: "stateUpdate", state: liveState(), event: "timerComplete" });
    }
    if (alarm.name === ALARM_KEEPALIVE && appState.timer.isRunning) {
      broadcast({ type: "stateUpdate", state: liveState() });
    }
  });
  browser.runtime.onConnect.addListener((port) => {
    ports.add(port);
    port.postMessage({ type: "stateUpdate", state: liveState() });
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
    broadcast({ type: "stateUpdate", state: liveState() });
  }
  function liveState() {
    return {
      ...appState,
      timer: { ...appState.timer, pausedTimeRemaining: getTimeRemaining(appState.timer) }
    };
  }
  browser.runtime.onMessage.addListener(
    (msg, _sender, sendResponse) => {
      if (msg.type === "getTimerState") {
        sendResponse({ timeRemaining: getTimeRemaining(appState.timer), mode: appState.timer.mode });
      }
      return false;
    }
  );
  async function handleMessage(msg, port) {
    switch (msg.type) {
      // ── Timer ────────────────────────────────────────────────────────────────
      case "timerStart":
        appState.timer = startTimer(appState.timer);
        await persistState();
        broadcastState();
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
      // ── Tasks (manual CRUD) ──────────────────────────────────────────────────
      case "createTask": {
        appState.tasks.push(msg.task);
        await persistState();
        broadcastState();
        githubSync((gh) => gh.writeTasks(appState.tasks, `task: add ${msg.task.title}`));
        break;
      }
      case "updateTask": {
        appState.tasks = appState.tasks.map((t) => t.id === msg.task.id ? msg.task : t);
        await persistState();
        broadcastState();
        githubSync((gh) => gh.writeTasks(appState.tasks, `task: update ${msg.task.title}`));
        break;
      }
      case "deleteTask": {
        appState.tasks = appState.tasks.filter((t) => t.id !== msg.id);
        await persistState();
        broadcastState();
        githubSync((gh) => gh.writeTasks(appState.tasks, `task: delete ${msg.id}`));
        break;
      }
      // ── AI ───────────────────────────────────────────────────────────────────
      case "aiCommand": {
        if (!settings.ai) {
          port.postMessage({ type: "error", message: "AI not configured. Open Settings." });
          break;
        }
        port.postMessage({ type: "aiThinking" });
        try {
          const ai = new AIClient(settings.ai);
          const res = await ai.sendCommand(
            msg.prompt,
            appState.tasks,
            appState.memory,
            appState.calendarCache,
            msg.imageData
          );
          const hasDeletes = res.actions.some((a) => a.type === "delete_task");
          const needsApproval = !settings.autoApproveAI && hasDeletes;
          if (!needsApproval) {
            await doApplyAI(res, msg.prompt, port);
          } else {
            const { tasks: preview } = applyActions(appState.tasks, appState.memory, res.actions);
            const diff = computeDiff(appState.tasks, preview);
            port.postMessage({ type: "aiPendingApproval", response: res, diff });
          }
        } catch (e) {
          port.postMessage({ type: "error", message: e.message });
        }
        break;
      }
      case "aiApprove":
        await doApplyAI(msg.response, msg.prompt, port);
        break;
      case "aiReject":
        port.postMessage({ type: "aiRejected" });
        break;
      case "undoLast": {
        const snaps = await Storage.getSnapshots();
        if (snaps.length < 2) {
          port.postMessage({ type: "error", message: "Nothing to undo." });
          break;
        }
        const prev = snaps[1];
        appState.tasks = prev.tasks;
        appState.memory = prev.memory;
        await persistState();
        broadcastState();
        githubSync(async (gh) => {
          await Promise.all([
            gh.writeTasks(appState.tasks, "undo: revert tasks"),
            gh.writeMemory(appState.memory, "undo: revert memory")
          ]);
        });
        port.postMessage({ type: "undoComplete" });
        break;
      }
      case "revertToSnapshot": {
        const snaps = await Storage.getSnapshots();
        const snap = snaps.find((s) => s.id === msg.snapshotId);
        if (!snap) break;
        appState.tasks = snap.tasks;
        appState.memory = snap.memory;
        await persistState();
        broadcastState();
        githubSync(async (gh) => {
          await Promise.all([
            gh.writeTasks(appState.tasks, `revert: snapshot ${snap.id}`),
            gh.writeMemory(appState.memory, `revert: snapshot ${snap.id}`)
          ]);
        });
        break;
      }
      case "syncNow": {
        if (!settings.github) {
          port.postMessage({ type: "error", message: "GitHub not configured." });
          break;
        }
        try {
          await syncFromGitHub();
          port.postMessage({ type: "syncComplete" });
        } catch (e) {
          port.postMessage({ type: "error", message: e.message });
        }
        break;
      }
      // ── Settings ─────────────────────────────────────────────────────────────
      case "settingsUpdated":
        settings = msg.settings;
        await Storage.setSettings(settings);
        broadcastState();
        break;
      // ── Block state ───────────────────────────────────────────────────────────
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
      // ── Gmail ─────────────────────────────────────────────────────────────────
      case "gmailScan": {
        const token = await ensureGoogleToken();
        if (!token) {
          port.postMessage({ type: "error", message: "Gmail not connected." });
          break;
        }
        try {
          const gmail = new GmailClient(token);
          const messages = await gmail.getRecentUnread();
          port.postMessage({ type: "gmailMessages", messages });
        } catch (e) {
          port.postMessage({ type: "error", message: e.message });
        }
        break;
      }
    }
  }
  async function doApplyAI(response, prompt, port) {
    const before = clone(appState.tasks);
    const { tasks, memory, calendarRequests } = applyActions(
      appState.tasks,
      appState.memory,
      response.actions
    );
    appState.tasks = tasks;
    appState.memory = memory;
    await persistState();
    broadcastState();
    let calendarNote = "";
    if (calendarRequests.length) {
      const tok = await ensureGoogleToken();
      if (!tok) {
        calendarNote = "\n\n\u26A0 Google Calendar not connected \u2014 event not saved. Connect it in Settings.";
      } else {
        try {
          const cal = new CalendarClient(tok);
          await Promise.all(calendarRequests.map((r) => cal.createEvent(r)));
        } catch (e) {
          calendarNote = `

\u26A0 Calendar error: ${e.message}`;
        }
      }
    }
    if (settings.github) {
      const gh = new GitHubClient(settings.github);
      commitChange(gh, before, tasks, memory, prompt, response.actions.map((a) => a.type)).catch(console.warn);
    }
    port.postMessage({ type: "aiComplete", message: response.message + calendarNote });
  }
  async function syncFromGitHub() {
    if (!settings.github) return;
    const gh = new GitHubClient(settings.github);
    await gh.bootstrap();
    const [tasks, memory] = await Promise.all([gh.readTasks(), gh.readMemory()]);
    appState.tasks = tasks;
    appState.memory = memory;
    appState.lastSyncedAt = isoNow();
    await persistState();
    broadcastState();
  }
  function githubSync(fn) {
    if (!settings.github) return;
    const gh = new GitHubClient(settings.github);
    fn(gh).catch((e) => console.warn("[styl] gh sync:", e));
  }
  async function ensureGoogleToken() {
    const g = settings.google;
    if (!g) return null;
    if (g.accessToken && g.tokenExpiry && Date.now() < g.tokenExpiry - 6e4) {
      return g.accessToken;
    }
    if (!g.refreshToken || !g.clientId || !g.clientSecret) return g.accessToken ?? null;
    try {
      const res = await fetch("https://oauth2.googleapis.com/token", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: g.clientId,
          client_secret: g.clientSecret,
          refresh_token: g.refreshToken,
          grant_type: "refresh_token"
        }).toString()
      });
      const data = await res.json();
      if (data.error || !data.access_token) throw new Error(data.error ?? "no token");
      settings.google = {
        ...g,
        accessToken: data.access_token,
        tokenExpiry: Date.now() + (data.expires_in ?? 3600) * 1e3
      };
      await Storage.setSettings(settings);
      return data.access_token;
    } catch (e) {
      console.warn("[styl] token refresh failed:", e);
      return g.accessToken ?? null;
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
  function defaultMemory2() {
    return {
      preferences: {},
      recurring_events: [],
      habits: [],
      task_patterns: {},
      known_entities: {}
    };
  }
})();
//# sourceMappingURL=background.js.map
