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
  var CAL_TOOL_DESC = "Fetch Google Calendar events for any date range. Use this for specific future dates, scheduling questions, or availability checks \u2014 especially beyond the next 14 days.";
  var ANTHROPIC_CAL_TOOL = {
    name: "get_calendar_events",
    description: CAL_TOOL_DESC,
    input_schema: {
      type: "object",
      properties: {
        start_date: { type: "string", description: "Start date YYYY-MM-DD" },
        end_date: { type: "string", description: "End date YYYY-MM-DD (inclusive)" }
      },
      required: ["start_date", "end_date"]
    }
  };
  var OPENAI_CAL_TOOL = {
    type: "function",
    function: {
      name: "get_calendar_events",
      description: CAL_TOOL_DESC,
      parameters: {
        type: "object",
        properties: {
          start_date: { type: "string", description: "Start date YYYY-MM-DD" },
          end_date: { type: "string", description: "End date YYYY-MM-DD (inclusive)" }
        },
        required: ["start_date", "end_date"]
      }
    }
  };
  function buildSystemPrompt() {
    const now = /* @__PURE__ */ new Date();
    const dateStr = now.toLocaleDateString("en-US", { weekday: "long", year: "numeric", month: "long", day: "numeric" });
    const timeStr = now.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
    const nowIso = now.toISOString();
    return `You are a personal planning assistant embedded in a browser extension called Styl.
RIGHT NOW: ${dateStr} at ${timeStr} (${nowIso})

You manage tasks, persistent memory, and Google Calendar. Always return ONLY valid JSON \u2014 no markdown fences, no prose wrappers.

OUTPUT SCHEMA:
{
  "message": "<your response to the user \u2014 can be multiple lines, use \\n for line breaks>",
  "actions": [ { "type": "<action_type>", "payload": { ...fields } } ],
  "requiresApproval": false
}

AVAILABLE ACTIONS:
  create_task           payload: { title, status?, priority?, estimated_duration_minutes?, due_date? (YYYY-MM-DD), project?, notes? }
  update_task           payload: { id, ...fields to update }
  delete_task           payload: { id }
  reorder_tasks         payload: { orderedIds: ["id1","id2",...] }
  plan_day              payload: { orderedTasks: [{ id, estimated_duration_minutes? }] }
  update_memory         payload: { path: "dot.key.path", value: <any> }
  add_fact              payload: { text: "concise atomic fact about the user" }
  create_calendar_event payload: { title, start (ISO datetime), end (ISO datetime), description? }
  delete_calendar_event payload: { id }

RULES:
- requiresApproval = true ONLY for 3+ simultaneous deletes
- Tasks = flexible to-do items with no fixed time. Calendar events = fixed-time appointments only.
- Priority inference: "urgent/asap/critical/due today" \u2192 high \xB7 "sometime/eventually" \u2192 low \xB7 default \u2192 medium
- ALWAYS call add_fact when you learn anything new about the user: schedule, preferences, habits, projects, people \u2014 this builds your long-term model of them.
- For calendar questions beyond 14 days away, use the get_calendar_events tool.
- Extract tasks from screenshots literally \u2014 preserve exact wording.

PLANNING ("plan my day" or similar):
  1. Determine start time: use work_hours from memory if set, otherwise use current time (${timeStr}) as start.
  2. Build a time-blocked schedule by slotting todo tasks into the day in this order: high priority \u2192 due date soonest \u2192 medium priority \u2192 low priority. Assign realistic durations (default: 25\u201345 min for focused tasks, 5\u201315 min for quick tasks) if not already set.
  3. Treat every calendar event today as a fixed block \u2014 do not schedule tasks during those times. Show them in the schedule too.
  4. Factor in breaks: 5\u201310 min after every 1\u20132 tasks, longer break mid-day if schedule allows.
  5. Write the full time-blocked schedule in the message field, like:
       9:00 AM  \u25B8 Task name (30 min)
       9:35 AM  \u25B8 Another task (45 min)
      10:20 AM  \u{1F4C5} Team standup [calendar] (30 min)
      10:50 AM  \u25B8 Next task (25 min)
       ...
  6. Emit ONE plan_day action with the task order and updated durations. Don't emit individual update_task actions for duration \u2014 plan_day handles that.
  7. End the message with a one-line motivational note tailored to the day's workload.`;
  }
  var AIClient = class {
    constructor(cfg) {
      this.cfg = cfg;
    }
    async sendCommand(prompt, tasks, memory, calendar, imageData, fetchCalendar) {
      const context = buildContext(tasks, memory, calendar);
      return this.cfg.provider === "anthropic" ? this.callAnthropic(prompt, context, imageData, fetchCalendar) : this.callOpenAI(prompt, context, imageData, fetchCalendar);
    }
    async callAnthropic(prompt, context, imageData, fetchCalendar) {
      const content = [];
      if (imageData) {
        content.push({ type: "image", source: { type: "base64", media_type: "image/png", data: imageData } });
      }
      content.push({ type: "text", text: `${context}

User: ${prompt}` });
      const messages = [{ role: "user", content }];
      const tools = fetchCalendar ? [ANTHROPIC_CAL_TOOL] : void 0;
      for (let turn = 0; turn < 5; turn++) {
        const body = {
          model: this.cfg.model || "claude-haiku-4-5-20251001",
          max_tokens: 2048,
          system: buildSystemPrompt(),
          messages
        };
        if (tools) body.tools = tools;
        const res = await fetch("https://api.anthropic.com/v1/messages", {
          method: "POST",
          headers: {
            "x-api-key": this.cfg.apiKey,
            "anthropic-version": "2023-06-01",
            "content-type": "application/json"
          },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        if (data.stop_reason === "tool_use" && fetchCalendar) {
          const toolUse = data.content.find((b) => b.type === "tool_use");
          if (!toolUse) break;
          const { start_date, end_date } = toolUse.input;
          const events = await fetchCalendar(start_date, end_date);
          messages.push({ role: "assistant", content: data.content });
          messages.push({
            role: "user",
            content: [{ type: "tool_result", tool_use_id: toolUse.id, content: formatEventsForTool(events, start_date, end_date) }]
          });
          continue;
        }
        const textBlock = data.content.find((b) => b.type === "text");
        if (textBlock?.text) return parseAIResponse(textBlock.text);
        break;
      }
      return { message: "Done.", actions: [], requiresApproval: false };
    }
    async callOpenAI(prompt, context, imageData, fetchCalendar) {
      const userContent = [];
      if (imageData) {
        userContent.push({ type: "image_url", image_url: { url: `data:image/png;base64,${imageData}` } });
      }
      userContent.push({ type: "text", text: `${context}

User: ${prompt}` });
      const messages = [
        { role: "system", content: buildSystemPrompt() },
        { role: "user", content: userContent }
      ];
      const tools = fetchCalendar ? [OPENAI_CAL_TOOL] : void 0;
      for (let turn = 0; turn < 5; turn++) {
        const body = {
          model: this.cfg.model || "gpt-4o-mini",
          messages,
          max_tokens: 2048
        };
        if (tools) body.tools = tools;
        else body.response_format = { type: "json_object" };
        const res = await fetch("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { Authorization: `Bearer ${this.cfg.apiKey}`, "Content-Type": "application/json" },
          body: JSON.stringify(body)
        });
        if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
        const data = await res.json();
        const choice = data.choices[0];
        if (choice.finish_reason === "tool_calls" && fetchCalendar) {
          const call = choice.message.tool_calls?.[0];
          if (!call) break;
          const { start_date, end_date } = JSON.parse(call.function.arguments);
          const events = await fetchCalendar(start_date, end_date);
          messages.push(choice.message);
          for (const tc of choice.message.tool_calls ?? []) {
            messages.push({ role: "tool", tool_call_id: tc.id, content: formatEventsForTool(events, start_date, end_date) });
          }
          continue;
        }
        if (choice.message.content) return parseAIResponse(choice.message.content);
        break;
      }
      return { message: "Done.", actions: [], requiresApproval: false };
    }
  };
  function applyActions(tasks, memory, actions) {
    let newTasks = [...tasks];
    const newMem = JSON.parse(JSON.stringify(memory));
    if (!Array.isArray(newMem.facts)) newMem.facts = [];
    const calReqs = [];
    const calDeletes = [];
    for (const rawAction of actions) {
      if (!rawAction.type) continue;
      const action = {
        ...rawAction,
        type: rawAction.type.replace(/([a-z])([A-Z])/g, "$1_$2").toLowerCase().replace(/-/g, "_")
      };
      switch (action.type) {
        case "create_task": {
          const p = action.payload ?? action;
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
          const p = action.payload ?? action;
          newTasks = newTasks.map((t) => t.id === p.id ? { ...t, ...p, updated_at: isoNow() } : t);
          break;
        }
        case "delete_task": {
          const { id } = action.payload ?? action;
          newTasks = newTasks.filter((t) => t.id !== id);
          break;
        }
        case "reorder_tasks": {
          const { orderedIds } = action.payload ?? action;
          const map = new Map(newTasks.map((t) => [t.id, t]));
          newTasks = orderedIds.map((id) => map.get(id)).filter(Boolean);
          break;
        }
        case "plan_day": {
          const { orderedTasks } = action.payload ?? action;
          const idxMap = new Map(orderedTasks.map((t, i) => [t.id, i]));
          const durMap = new Map(orderedTasks.filter((t) => t.estimated_duration_minutes != null).map((t) => [t.id, t.estimated_duration_minutes]));
          newTasks = [...newTasks].sort((a, b) => (idxMap.get(a.id) ?? 999) - (idxMap.get(b.id) ?? 999));
          newTasks = newTasks.map((t) => durMap.has(t.id) ? { ...t, estimated_duration_minutes: durMap.get(t.id), updated_at: isoNow() } : t);
          break;
        }
        case "update_memory": {
          const { path, value } = action.payload ?? action;
          setNested(newMem, path, value);
          break;
        }
        case "add_fact": {
          const { text } = action.payload ?? action;
          if (text && !newMem.facts.includes(text)) newMem.facts.push(text);
          break;
        }
        case "create_calendar_event": {
          calReqs.push(action.payload ?? action);
          break;
        }
        case "delete_calendar_event": {
          const { id } = action.payload ?? action;
          calDeletes.push(id);
          break;
        }
      }
    }
    return { tasks: newTasks, memory: newMem, calendarRequests: calReqs, calendarDeleteRequests: calDeletes };
  }
  function buildContext(tasks, memory, calendar) {
    const parts = [];
    const todo = tasks.filter((t) => t.status !== "done");
    const done = tasks.filter((t) => t.status === "done");
    const byPri = (p) => todo.filter((t) => t.priority === p);
    const fmtTask = (t) => {
      let s = `    [${t.id}] ${t.title}`;
      if (t.estimated_duration_minutes) s += ` \u2014 ${t.estimated_duration_minutes}min`;
      if (t.due_date) s += ` \xB7 due ${t.due_date}`;
      if (t.project) s += ` \xB7 #${t.project}`;
      if (t.notes) s += `
      notes: ${t.notes}`;
      return s;
    };
    const taskLines = [`TASKS  (${todo.length} todo, ${done.length} done)`];
    if (byPri("high").length) {
      taskLines.push("  HIGH PRIORITY:");
      byPri("high").forEach((t) => taskLines.push(fmtTask(t)));
    }
    if (byPri("medium").length) {
      taskLines.push("  MEDIUM PRIORITY:");
      byPri("medium").forEach((t) => taskLines.push(fmtTask(t)));
    }
    if (byPri("low").length) {
      taskLines.push("  LOW PRIORITY:");
      byPri("low").forEach((t) => taskLines.push(fmtTask(t)));
    }
    if (done.length) taskLines.push(`  COMPLETED (${done.length}): ${done.map((t) => t.title).join(" \xB7 ")}`);
    if (todo.length === 0) taskLines.push("  (no open tasks)");
    parts.push(taskLines.join("\n"));
    const calLines = ["CALENDAR"];
    if (calendar.length) {
      const now = /* @__PURE__ */ new Date();
      const todayKey = dateKey(now);
      const todayEvt = calendar.filter((e) => dateKey(new Date(e.start)) === todayKey);
      const upcoming = calendar.filter((e) => dateKey(new Date(e.start)) > todayKey).slice(0, 12);
      const fmtEvt = (e) => {
        const start = new Date(e.start);
        const end = new Date(e.end);
        const time = e.start.includes("T") ? start.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" }) : "All day";
        const durMin = e.start.includes("T") ? Math.round((end.getTime() - start.getTime()) / 6e4) : 0;
        return `    ${time.padEnd(10)} ${e.title}${durMin ? ` (${durMin} min)` : ""}  [id:${e.id}]`;
      };
      if (todayEvt.length) {
        calLines.push(`  Today (${todayEvt.length} fixed block${todayEvt.length !== 1 ? "s" : ""} \u2014 work tasks around these):`);
        todayEvt.forEach((e) => calLines.push(fmtEvt(e)));
      } else {
        calLines.push("  Today: no events \u2014 full day available for tasks");
      }
      if (upcoming.length) {
        calLines.push("  Upcoming:");
        upcoming.forEach((e) => calLines.push(`    ${dateKey(new Date(e.start))}  ${e.title}`));
      }
    } else {
      calLines.push("  No events in cache \u2014 use get_calendar_events tool if needed");
    }
    parts.push(calLines.join("\n"));
    const memLines = ["MEMORY ABOUT USER"];
    let hasMemory = false;
    if (memory.about_me) {
      memLines.push(`  About: ${memory.about_me}`);
      hasMemory = true;
    }
    if (memory.work_hours) {
      const wh = memory.work_hours;
      memLines.push(`  Work hours: ${wh.start} \u2013 ${wh.end}${wh.days ? ` (${wh.days.join(", ")})` : ""}`);
      hasMemory = true;
    }
    if (memory.habits?.length) {
      memLines.push(`  Habits: ${memory.habits.join(" \xB7 ")}`);
      hasMemory = true;
    }
    if (memory.recurring_events?.length) {
      memLines.push("  Recurring events:");
      memory.recurring_events.forEach((e) => memLines.push(`    - ${e.name}: ${e.pattern}`));
      hasMemory = true;
    }
    if (Object.keys(memory.preferences ?? {}).length) {
      memLines.push("  Preferences:");
      Object.entries(memory.preferences).forEach(([k, v]) => memLines.push(`    ${k}: ${v}`));
      hasMemory = true;
    }
    if (Object.keys(memory.known_entities ?? {}).length) {
      memLines.push("  People & projects:");
      Object.entries(memory.known_entities).forEach(([k, v]) => memLines.push(`    ${k}: ${v}`));
      hasMemory = true;
    }
    const facts = memory.facts ?? [];
    if (facts.length) {
      memLines.push("  Learned facts:");
      facts.forEach((f) => memLines.push(`    \u2022 ${f}`));
      hasMemory = true;
    }
    if (!hasMemory) {
      memLines.push("  (none yet \u2014 save facts about the user with add_fact as you learn them)");
    }
    parts.push(memLines.join("\n"));
    return parts.join("\n\n");
  }
  function formatEventsForTool(events, startDate, endDate) {
    if (!events.length) return `No events found between ${startDate} and ${endDate}.`;
    return `Events from ${startDate} to ${endDate}:
` + events.map((e) => {
      const time = e.start.includes("T") ? new Date(e.start).toLocaleString("en-US", { weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : `${e.start} (all day)`;
      return `  - ${time}: ${e.title}${e.description ? ` (${e.description})` : ""}`;
    }).join("\n");
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
  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
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
    // ── Shared fetch across all user calendars ──────────────────────────────────
    async fetchAcrossAllCalendars(params) {
      const listRes = await fetch(
        "https://www.googleapis.com/calendar/v3/users/me/calendarList",
        { headers: this.auth }
      );
      if (!listRes.ok) throw new Error(`Calendar list error ${listRes.status}: ${await listRes.text()}`);
      const listData = await listRes.json();
      const calIds = (listData.items ?? []).filter((c) => c.accessRole === "owner" || c.accessRole === "writer" || c.accessRole === "reader").map((c) => c.id);
      if (!calIds.length) calIds.push("primary");
      const results = await Promise.allSettled(
        calIds.map(async (calId) => {
          const res = await fetch(
            `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
            { headers: this.auth }
          );
          if (!res.ok) return [];
          const data = await res.json();
          return (data.items ?? []).map((e) => ({
            id: e.id,
            title: e.summary ?? "(no title)",
            start: e.start.dateTime ?? e.start.date ?? "",
            end: e.end.dateTime ?? e.end.date ?? "",
            description: e.description
          }));
        })
      );
      const seen = /* @__PURE__ */ new Set();
      const all = [];
      for (const r of results) {
        if (r.status === "fulfilled") {
          for (const e of r.value) {
            if (!seen.has(e.id)) {
              seen.add(e.id);
              all.push(e);
            }
          }
        }
      }
      all.sort((a, b) => a.start.localeCompare(b.start));
      return all;
    }
    // ── Public methods ──────────────────────────────────────────────────────────
    async getUpcomingEvents(daysAhead = 14) {
      const now = /* @__PURE__ */ new Date();
      const end = new Date(now);
      end.setDate(now.getDate() + daysAhead);
      const params = new URLSearchParams({
        timeMin: now.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "100"
      });
      try {
        const events = await this.fetchAcrossAllCalendars(params);
        return { events };
      } catch (e) {
        return { events: [], warning: e.message };
      }
    }
    async getEventsForRange(startDate, endDate) {
      const start = /* @__PURE__ */ new Date(`${startDate}T00:00:00`);
      const end = /* @__PURE__ */ new Date(`${endDate}T23:59:59`);
      const params = new URLSearchParams({
        timeMin: start.toISOString(),
        timeMax: end.toISOString(),
        singleEvents: "true",
        orderBy: "startTime",
        maxResults: "100"
      });
      return this.fetchAcrossAllCalendars(params);
    }
    async createEvent(event) {
      const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
      const res = await fetch(
        "https://www.googleapis.com/calendar/v3/calendars/primary/events",
        {
          method: "POST",
          headers: { ...this.auth, "Content-Type": "application/json" },
          body: JSON.stringify({
            summary: event.title,
            description: event.description,
            start: { dateTime: event.start, timeZone: tz },
            end: { dateTime: event.end, timeZone: tz }
          })
        }
      );
      if (!res.ok) throw new Error(`Calendar create error ${res.status}: ${await res.text()}`);
    }
    async deleteEvent(eventId) {
      const res = await fetch(
        `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
        { method: "DELETE", headers: this.auth }
      );
      if (!res.ok && res.status !== 404) {
        throw new Error(`Calendar delete error ${res.status}: ${await res.text()}`);
      }
    }
    /** @deprecated Use getUpcomingEvents instead */
    async getTodayEvents() {
      const { events } = await this.getUpcomingEvents(1);
      return events;
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
    if (settings.github && !savedState) {
      syncFromGitHub().catch((e) => console.warn("[styl] boot sync:", e));
    }
    refreshCalendarCache().catch(() => {
    });
  })();
  async function refreshCalendarCache() {
    const token = await ensureGoogleToken();
    if (!token) return {};
    const { events, warning } = await new CalendarClient(token).getUpcomingEvents(14);
    appState.calendarCache = events;
    await persistState();
    broadcast({ type: "calendarData", events, error: warning });
    return { warning };
  }
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
    return appState;
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
      case "reorderTasks": {
        const idMap = new Map(appState.tasks.map((t) => [t.id, t]));
        appState.tasks = msg.ids.filter((id) => idMap.has(id)).map((id) => idMap.get(id));
        await persistState();
        broadcastState();
        githubSync((gh) => gh.writeTasks(appState.tasks, "task: reorder"));
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
          const calToken = await ensureGoogleToken();
          if (calToken) {
            try {
              const { events } = await new CalendarClient(calToken).getUpcomingEvents(14);
              appState.calendarCache = events;
            } catch {
            }
          }
          const fetchCalendar = settings.google ? async (start, end) => {
            port.postMessage({ type: "aiToolUse", tool: "get_calendar_events", input: { start, end } });
            const tok = await ensureGoogleToken();
            if (!tok) return [];
            return new CalendarClient(tok).getEventsForRange(start, end);
          } : void 0;
          const ai = new AIClient(settings.ai);
          const res = await ai.sendCommand(
            msg.prompt,
            appState.tasks,
            appState.memory,
            appState.calendarCache,
            msg.imageData,
            fetchCalendar
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
      // ── Calendar ──────────────────────────────────────────────────────────────
      case "calendarRefresh": {
        const token = await ensureGoogleToken();
        if (!token) {
          port.postMessage({ type: "calendarData", events: [], error: "Google not connected." });
          break;
        }
        try {
          await refreshCalendarCache();
        } catch (e) {
          port.postMessage({ type: "calendarData", events: appState.calendarCache, error: e.message });
        }
        break;
      }
    }
  }
  async function doApplyAI(response, prompt, port) {
    const before = clone(appState.tasks);
    const { tasks, memory, calendarRequests, calendarDeleteRequests } = applyActions(
      appState.tasks,
      appState.memory,
      response.actions
    );
    appState.tasks = tasks;
    appState.memory = memory;
    await persistState();
    broadcastState();
    let calendarNote = "";
    if (calendarRequests.length || calendarDeleteRequests.length) {
      const tok = await ensureGoogleToken();
      if (!tok) {
        calendarNote = "\n\n\u26A0 Google Calendar not connected \u2014 calendar change not saved. Connect it in Settings.";
      } else {
        try {
          const cal = new CalendarClient(tok);
          await Promise.all([
            ...calendarRequests.map((r) => cal.createEvent(r)),
            ...calendarDeleteRequests.map((id) => cal.deleteEvent(id))
          ]);
          const { events: refreshed } = await cal.getUpcomingEvents(14);
          appState.calendarCache = refreshed;
          await persistState();
          broadcast({ type: "calendarData", events: refreshed });
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
  function defaultMemory2() {
    return {
      preferences: {},
      recurring_events: [],
      habits: [],
      task_patterns: {},
      known_entities: {},
      facts: []
    };
  }
})();
//# sourceMappingURL=background.js.map
