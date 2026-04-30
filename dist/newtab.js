"use strict";
(() => {
  // src/shared/utils.ts
  function generateId() {
    return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function isoNow() {
    return (/* @__PURE__ */ new Date()).toISOString();
  }
  function fmt(seconds) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
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
  var pendingAIResp = null;
  var pendingPrompt = "";
  var promptHistory = JSON.parse(localStorage.getItem("styl_history") ?? "[]");
  var historyIdx = -1;
  var pendingImages = [];
  var slashActive = -1;
  var thinkingNode = null;
  var draggedId = null;
  var SLASH_CMDS = [
    { cmd: "/plan", desc: "Reorder tasks by priority & duration", fill: "plan my day" },
    { cmd: "/today", desc: "What's on my calendar today", fill: "what's on my calendar today?" },
    { cmd: "/week", desc: "Show this week's schedule", fill: "what do I have this week?" },
    { cmd: "/tasks", desc: "List all tasks", fill: "list all my tasks" },
    { cmd: "/remember", desc: "Tell the AI to remember something", fill: "/remember " },
    { cmd: "/directive", desc: "Set a standing instruction for the AI", fill: "/directive " },
    { cmd: "/undo", desc: "Undo last AI change", fill: null },
    { cmd: "/clear", desc: "Clear this conversation", fill: null }
  ];
  function connect() {
    port = browser.runtime.connect({ name: "newtab" });
    port.onMessage.addListener((msg) => {
      switch (msg.type) {
        case "stateUpdate":
          state = msg.state;
          renderTimer();
          renderTasks();
          renderCalendar(state.calendarCache ?? []);
          renderAddMinBtn();
          if (msg.event === "timerComplete") playChime();
          break;
        case "aiThinking":
          showThinking();
          break;
        case "aiToolUse": {
          const toolInput = msg.input;
          const label = msg.tool === "get_calendar_events" ? `Fetching calendar for ${toolInput.start}\u2013${toolInput.end}\u2026` : `Using tool: ${msg.tool}`;
          appendToolMsg(label);
          break;
        }
        case "aiComplete":
          removeThinking();
          appendAssistantMsg(msg.message, false);
          clearApproval();
          break;
        case "aiPendingApproval":
          removeThinking();
          pendingAIResp = msg.response;
          pendingPrompt = "";
          appendAssistantMsg(msg.response.message, false);
          showDiff(msg.diff);
          showApproval();
          break;
        case "aiRejected":
          clearApproval();
          appendAssistantMsg("Cancelled.", false);
          break;
        case "undoComplete":
          appendAssistantMsg("Done \u2014 last change undone.", false);
          break;
        case "error":
          removeThinking();
          clearApproval();
          appendAssistantMsg(`\u26A0 ${msg.message}`, true);
          break;
        case "calendarData": {
          const events = msg.events;
          const warn = msg.error;
          renderCalendar(events, warn);
          if (thinkingNode) {
            removeThinking();
            const summary = events.length ? `${events.length} event${events.length !== 1 ? "s" : ""} in the next 14 days.${warn ? "\n\u26A0 " + warn : ""}` : warn ? `\u26A0 ${warn}` : "No upcoming events found.";
            appendAssistantMsg(summary, !!warn && !events.length);
          }
          break;
        }
      }
    });
    port.onDisconnect.addListener(() => {
      port = null;
      setTimeout(connect, 400);
    });
    port.postMessage({ type: "calendarRefresh" });
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
      document.getElementById("time-text").textContent = fmt(t.pausedTimeRemaining);
    }
    const progress = t.sessionTotal > 0 ? t.pausedTimeRemaining / t.sessionTotal : 1;
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
  var collapsedGroups = new Set(
    JSON.parse(localStorage.getItem("styl_collapsed_groups") ?? "[]")
  );
  function toggleGroup(project) {
    if (collapsedGroups.has(project)) collapsedGroups.delete(project);
    else collapsedGroups.add(project);
    localStorage.setItem("styl_collapsed_groups", JSON.stringify([...collapsedGroups]));
    renderTasks();
  }
  function renderTasks() {
    const tasks = state?.tasks ?? [];
    const list = document.getElementById("task-list");
    list.innerHTML = "";
    if (tasks.length === 0) {
      const empty = document.createElement("div");
      empty.className = "task-empty";
      empty.textContent = "No tasks \u2014 add one or ask the AI.";
      list.appendChild(empty);
      return;
    }
    const groups = /* @__PURE__ */ new Map();
    const noGroup = [];
    for (const t of tasks) {
      if (t.project) {
        if (!groups.has(t.project)) groups.set(t.project, []);
        groups.get(t.project).push(t);
      } else {
        noGroup.push(t);
      }
    }
    for (const t of noGroup) list.appendChild(buildTaskItem(t));
    for (const [project, gtasks] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const collapsed = collapsedGroups.has(project);
      const done = gtasks.filter((t) => t.status === "done").length;
      const header = document.createElement("div");
      header.className = "task-group-header";
      header.addEventListener("click", () => toggleGroup(project));
      const arrow = document.createElement("span");
      arrow.className = "task-group-arrow";
      arrow.textContent = collapsed ? "\u25B6" : "\u25BC";
      const label = document.createElement("span");
      label.className = "task-group-label";
      label.textContent = project;
      const badge = document.createElement("span");
      badge.className = "task-group-badge";
      badge.textContent = `${done}/${gtasks.length}`;
      header.append(arrow, label, badge);
      list.appendChild(header);
      if (!collapsed) {
        for (const t of gtasks) list.appendChild(buildTaskItem(t));
      }
    }
  }
  function buildTaskItem(task) {
    const row = document.createElement("div");
    row.className = `task-item ${task.status === "done" ? "done" : ""}`;
    row.dataset.id = task.id;
    row.draggable = true;
    row.addEventListener("dragstart", (e) => {
      draggedId = task.id;
      row.classList.add("dragging");
      e.dataTransfer.effectAllowed = "move";
      e.dataTransfer.setData("text/plain", task.id);
    });
    row.addEventListener("dragend", () => {
      draggedId = null;
      row.classList.remove("dragging");
      clearDragIndicators();
    });
    row.addEventListener("dragover", (e) => {
      e.preventDefault();
      if (draggedId === task.id) return;
      e.dataTransfer.dropEffect = "move";
      clearDragIndicators();
      const rect = row.getBoundingClientRect();
      const y = e.clientY - rect.top;
      const h = rect.height;
      if (y < h * 0.33) row.classList.add("drag-over-top");
      else if (y > h * 0.67) row.classList.add("drag-over-bottom");
      else row.classList.add("drag-over-center");
    });
    row.addEventListener("dragleave", (e) => {
      if (!row.contains(e.relatedTarget)) {
        row.classList.remove("drag-over-top", "drag-over-bottom", "drag-over-center");
      }
    });
    row.addEventListener("drop", (e) => {
      e.preventDefault();
      if (!draggedId || draggedId === task.id) {
        clearDragIndicators();
        return;
      }
      const id = draggedId;
      const isCenter = row.classList.contains("drag-over-center");
      const isBefore = row.classList.contains("drag-over-top");
      clearDragIndicators();
      if (isCenter) showGroupDialog(id, task.id);
      else reorderTask(id, task.id, isBefore ? "before" : "after");
    });
    const PRIORITIES = ["low", "medium", "high"];
    const dot = document.createElement("span");
    dot.className = `task-dot priority-${task.priority}`;
    dot.title = `Priority: ${task.priority} (click to change)`;
    dot.style.cursor = "pointer";
    dot.addEventListener("click", (e) => {
      e.stopPropagation();
      const next = PRIORITIES[(PRIORITIES.indexOf(task.priority) + 1) % PRIORITIES.length];
      send({ type: "updateTask", task: { ...task, priority: next, updated_at: isoNow() } });
    });
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = task.status === "done";
    cb.className = "task-cb";
    cb.addEventListener("change", () => {
      send({ type: "updateTask", task: { ...task, status: cb.checked ? "done" : "todo", updated_at: isoNow() } });
    });
    const title = document.createElement("span");
    title.className = "task-title-text";
    title.textContent = task.title;
    title.addEventListener("click", () => startInlineEdit(task, title));
    const dur = document.createElement("span");
    dur.className = "task-dur";
    dur.textContent = task.estimated_duration_minutes ? `${task.estimated_duration_minutes}m` : "";
    const grp = document.createElement("span");
    grp.className = `task-group-tag${task.project ? " has-group" : ""}`;
    grp.textContent = task.project ?? "\uFF0B";
    grp.title = task.project ? `Group: ${task.project} (click to change)` : "Add to group";
    grp.addEventListener("click", (e) => {
      e.stopPropagation();
      startGroupEdit(task, grp);
    });
    const del = document.createElement("button");
    del.className = "task-del";
    del.textContent = "\xD7";
    del.title = "Delete";
    del.addEventListener("click", () => send({ type: "deleteTask", id: task.id }));
    row.append(dot, cb, title, dur, grp, del);
    return row;
  }
  function clearDragIndicators() {
    document.querySelectorAll(".task-item").forEach((el) => {
      el.classList.remove("drag-over-top", "drag-over-bottom", "drag-over-center");
    });
  }
  function reorderTask(fromId, targetId, position) {
    const items = Array.from(document.querySelectorAll(".task-item[data-id]"));
    const ids = items.map((el) => el.dataset.id);
    const fromIdx = ids.indexOf(fromId);
    if (fromIdx === -1) return;
    ids.splice(fromIdx, 1);
    const toIdx = ids.indexOf(targetId);
    if (toIdx === -1) return;
    ids.splice(position === "before" ? toIdx : toIdx + 1, 0, fromId);
    send({ type: "reorderTasks", ids });
  }
  function showGroupDialog(id1, id2) {
    const overlay = document.getElementById("group-dialog");
    const input = document.getElementById("group-dialog-input");
    const task1 = state?.tasks.find((t) => t.id === id1);
    const task2 = state?.tasks.find((t) => t.id === id2);
    input.value = task1?.project ?? task2?.project ?? "";
    overlay.classList.remove("hidden");
    input.focus();
    input.select();
    const commit = (name) => {
      overlay.classList.add("hidden");
      input.onkeydown = null;
      if (name !== null) {
        const project = name.trim() || void 0;
        [task1, task2].forEach((t) => {
          if (t) send({ type: "updateTask", task: { ...t, project, updated_at: isoNow() } });
        });
      }
    };
    document.getElementById("group-dialog-confirm").onclick = () => commit(input.value);
    document.getElementById("group-dialog-cancel").onclick = () => commit(null);
    input.onkeydown = (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        commit(input.value);
      }
      if (e.key === "Escape") commit(null);
    };
  }
  function startGroupEdit(task, el) {
    const input = document.createElement("input");
    input.className = "task-group-edit";
    input.value = task.project ?? "";
    input.placeholder = "Group\u2026";
    el.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const project = input.value.trim() || void 0;
      send({ type: "updateTask", task: { ...task, project, updated_at: isoNow() } });
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        input.value = task.project ?? "";
        input.blur();
      }
    });
  }
  function startInlineEdit(task, el) {
    const input = document.createElement("input");
    input.className = "task-inline-edit";
    input.value = task.title;
    el.replaceWith(input);
    input.focus();
    input.select();
    const commit = () => {
      const title = input.value.trim();
      if (title && title !== task.title) {
        send({ type: "updateTask", task: { ...task, title, updated_at: isoNow() } });
      } else {
        renderTasks();
      }
    };
    input.addEventListener("blur", commit);
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        input.blur();
      }
      if (e.key === "Escape") {
        input.value = task.title;
        input.blur();
      }
    });
  }
  var calView = "day";
  var calEvents = [];
  var calWarn;
  function renderCalendar(events, warn) {
    calEvents = events;
    calWarn = warn;
    const panel = document.getElementById("cal-panel");
    const body = document.getElementById("cal-body");
    const dateEl = document.getElementById("cal-header-date");
    document.querySelectorAll(".cal-tab").forEach((el) => {
      el.classList.toggle("active", el.dataset.view === calView);
    });
    if (!events.length && !warn) {
      panel.classList.add("hidden");
      return;
    }
    panel.classList.remove("hidden");
    body.innerHTML = "";
    if (warn) {
      const warnEl = document.createElement("div");
      warnEl.className = "cal-warn";
      warnEl.textContent = `\u26A0 ${warn}`;
      body.appendChild(warnEl);
    }
    if (calView === "day") renderDayView(events, body, dateEl);
    else renderWeekView(events, body, dateEl);
  }
  function calStartDt(e) {
    if (!e.start.includes("T")) {
      const [y, m, d] = e.start.split("-").map(Number);
      return new Date(y, m - 1, d, 12);
    }
    return new Date(e.start);
  }
  function calTimeLabel(e, startDt) {
    return !e.start.includes("T") ? "All day" : startDt.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  }
  function calEventRow(timeText, titleText) {
    const row = document.createElement("div");
    row.className = "cal-event-row";
    const timeEl = document.createElement("span");
    timeEl.className = "cal-event-time";
    timeEl.textContent = timeText;
    const titleEl = document.createElement("span");
    titleEl.className = "cal-event-title";
    titleEl.textContent = titleText;
    titleEl.title = titleText;
    row.append(timeEl, titleEl);
    return row;
  }
  function renderDayView(events, body, dateEl) {
    const now = /* @__PURE__ */ new Date();
    const todayKey = ymd(now);
    dateEl.textContent = now.toLocaleDateString("en-US", {
      weekday: "long",
      month: "long",
      day: "numeric"
    });
    const todayEvents = events.filter((e) => ymd(calStartDt(e)) === todayKey);
    if (!todayEvents.length) {
      const empty = document.createElement("div");
      empty.className = "cal-empty";
      empty.textContent = "Nothing scheduled for today";
      body.appendChild(empty);
      return;
    }
    for (const e of todayEvents) {
      const dt = calStartDt(e);
      body.appendChild(calEventRow(calTimeLabel(e, dt), e.title));
    }
  }
  function renderWeekView(events, body, dateEl) {
    const now = /* @__PURE__ */ new Date();
    const slots = /* @__PURE__ */ new Map();
    for (let i = 0; i < 7; i++) {
      const d = new Date(now);
      d.setDate(now.getDate() + i);
      const key = ymd(d);
      const label = i === 0 ? "Today" : i === 1 ? "Tomorrow" : d.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
      slots.set(key, { label, isToday: i === 0, rows: [] });
    }
    for (const e of events) {
      const key = ymd(calStartDt(e));
      slots.get(key)?.rows.push(e);
    }
    const last = new Date(now);
    last.setDate(now.getDate() + 6);
    dateEl.textContent = `${now.toLocaleDateString("en-US", { month: "short", day: "numeric" })} \u2013 ` + last.toLocaleDateString("en-US", { month: "short", day: "numeric" });
    let hasAny = false;
    for (const [, slot] of slots) {
      if (!slot.rows.length) continue;
      hasAny = true;
      const group = document.createElement("div");
      group.className = "cal-day-group";
      const label = document.createElement("div");
      label.className = `cal-day-label${slot.isToday ? " today-label" : ""}`;
      label.textContent = slot.label;
      group.appendChild(label);
      for (const e of slot.rows) {
        const dt = calStartDt(e);
        group.appendChild(calEventRow(calTimeLabel(e, dt), e.title));
      }
      body.appendChild(group);
    }
    if (!hasAny) {
      const empty = document.createElement("div");
      empty.className = "cal-empty";
      empty.textContent = "Nothing scheduled this week";
      body.appendChild(empty);
    }
  }
  function ymd(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  function chatMsgs() {
    return document.getElementById("ai-messages");
  }
  function scrollToBottom() {
    const el = chatMsgs();
    el.scrollTop = el.scrollHeight;
  }
  function removeEmptyState() {
    document.getElementById("ai-empty")?.remove();
  }
  function appendChatBubble(role, text, isError = false) {
    removeEmptyState();
    const msgs = chatMsgs();
    const wrap = document.createElement("div");
    wrap.className = `chat-msg ${role}${isError ? " error" : ""}`;
    const bubble = document.createElement("div");
    bubble.className = "chat-bubble";
    bubble.textContent = text;
    wrap.appendChild(bubble);
    msgs.appendChild(wrap);
    scrollToBottom();
    return wrap;
  }
  function appendAssistantMsg(text, isError) {
    appendChatBubble("assistant", text, isError);
  }
  function appendToolMsg(text) {
    appendChatBubble("tool", text);
  }
  function showThinking() {
    if (thinkingNode) return;
    removeEmptyState();
    const msgs = chatMsgs();
    const wrap = document.createElement("div");
    wrap.className = "chat-msg assistant";
    wrap.id = "ai-thinking-node";
    const bubble = document.createElement("div");
    bubble.className = "chat-thinking";
    bubble.innerHTML = '<span>Thinking</span><div class="thinking-dots"><div class="thinking-dot"></div><div class="thinking-dot"></div><div class="thinking-dot"></div></div>';
    wrap.appendChild(bubble);
    msgs.appendChild(wrap);
    scrollToBottom();
    thinkingNode = wrap;
  }
  function removeThinking() {
    thinkingNode?.remove();
    thinkingNode = null;
  }
  function showApproval() {
    document.getElementById("ai-actions").classList.remove("hidden");
  }
  function clearApproval() {
    document.getElementById("ai-actions").classList.add("hidden");
    pendingAIResp = null;
  }
  function clearConversation() {
    const msgs = chatMsgs();
    msgs.innerHTML = "";
    const empty = document.createElement("div");
    empty.className = "ai-empty";
    empty.id = "ai-empty";
    empty.innerHTML = '<div class="ai-empty-icon">\u2726</div><div class="ai-empty-hints"><span>Type <kbd>/</kbd> for commands</span><span class="ai-hint-sep">\xB7</span><span>Paste images with <kbd>\u2318V</kbd></span></div>';
    msgs.appendChild(empty);
    thinkingNode = null;
    pendingAIResp = null;
    clearApproval();
  }
  function updateSlashMenu(value) {
    const menu = document.getElementById("slash-menu");
    const textarea = document.getElementById("ai-input");
    if (!value.startsWith("/")) {
      menu.classList.add("hidden");
      slashActive = -1;
      return;
    }
    const q = value.toLowerCase();
    const matches = SLASH_CMDS.filter((c) => c.cmd.startsWith(q));
    if (!matches.length) {
      menu.classList.add("hidden");
      slashActive = -1;
      return;
    }
    menu.classList.remove("hidden");
    menu.innerHTML = "";
    if (slashActive >= matches.length) slashActive = 0;
    matches.forEach((cmd, i) => {
      const item = document.createElement("div");
      item.className = `slash-item${i === slashActive ? " active" : ""}`;
      const cmdEl = document.createElement("span");
      cmdEl.className = "slash-cmd";
      cmdEl.textContent = cmd.cmd;
      const descEl = document.createElement("span");
      descEl.className = "slash-desc";
      descEl.textContent = cmd.desc;
      item.append(cmdEl, descEl);
      item.addEventListener("mousedown", (e) => {
        e.preventDefault();
        selectSlashCmd(cmd, textarea);
      });
      menu.appendChild(item);
    });
  }
  function selectSlashCmd(cmd, textarea) {
    const menu = document.getElementById("slash-menu");
    menu.classList.add("hidden");
    slashActive = -1;
    if (cmd.fill === null) {
      if (cmd.cmd === "/clear") {
        clearConversation();
        textarea.value = "";
        return;
      }
      if (cmd.cmd === "/undo") {
        send({ type: "undoLast" });
        textarea.value = "";
        return;
      }
      return;
    }
    textarea.value = cmd.fill;
    textarea.focus();
    resizeTextarea(textarea);
    if (!cmd.fill.endsWith(" ")) {
      dispatchAI(textarea);
    }
  }
  function showDiff(diff) {
    const overlay = document.getElementById("diff-overlay");
    const content = document.getElementById("diff-content");
    content.innerHTML = "";
    const section = (label, items, cls) => {
      if (!items.length) return;
      const h = document.createElement("div");
      h.className = "diff-section-label";
      h.textContent = label;
      content.appendChild(h);
      items.forEach((t) => {
        const row = document.createElement("div");
        row.className = `diff-row ${cls}`;
        row.textContent = t.title;
        content.appendChild(row);
      });
    };
    section("Added", diff.added, "diff-add");
    section("Removed", diff.removed, "diff-rem");
    diff.modified.forEach(({ before, after }) => {
      const row = document.createElement("div");
      row.className = "diff-row diff-mod";
      row.textContent = `${before.title} \u2192 ${after.title}`;
      content.appendChild(row);
    });
    if (!diff.added.length && !diff.removed.length && !diff.modified.length) {
      content.textContent = "No task changes.";
    }
    overlay.classList.remove("hidden");
  }
  function hideDiff() {
    document.getElementById("diff-overlay").classList.add("hidden");
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
    document.querySelectorAll(".cal-tab").forEach((el) => {
      el.addEventListener("click", () => {
        calView = el.dataset.view;
        renderCalendar(calEvents, calWarn);
      });
    });
    const focusInput = document.getElementById("focus-input");
    focusInput.addEventListener(
      "input",
      () => localStorage.setItem("styl_focus_text", focusInput.value)
    );
    const aiTextarea = document.getElementById("ai-input");
    const aiSend = document.getElementById("ai-send");
    const aiImgIn = document.getElementById("ai-img");
    const aiImgBtn = document.getElementById("ai-img-btn");
    const aiClearBtn = document.getElementById("ai-clear-btn");
    aiTextarea.addEventListener("input", () => {
      resizeTextarea(aiTextarea);
      updateSlashMenu(aiTextarea.value);
    });
    aiTextarea.addEventListener("keydown", (e) => {
      const menu = document.getElementById("slash-menu");
      const menuVisible = !menu.classList.contains("hidden");
      const q = aiTextarea.value.toLowerCase();
      const matches = SLASH_CMDS.filter((c) => c.cmd.startsWith(q));
      if (menuVisible) {
        if (e.key === "ArrowDown") {
          e.preventDefault();
          slashActive = (slashActive + 1) % matches.length;
          updateSlashMenu(aiTextarea.value);
          return;
        }
        if (e.key === "ArrowUp") {
          e.preventDefault();
          slashActive = (slashActive - 1 + matches.length) % matches.length;
          updateSlashMenu(aiTextarea.value);
          return;
        }
        if (e.key === "Tab" || e.key === "Enter") {
          e.preventDefault();
          const chosen = matches[slashActive >= 0 ? slashActive : 0];
          if (chosen) selectSlashCmd(chosen, aiTextarea);
          return;
        }
        if (e.key === "Escape") {
          menu.classList.add("hidden");
          slashActive = -1;
          return;
        }
      }
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        dispatchAI(aiTextarea);
        return;
      }
      if (e.key === "ArrowUp" && aiTextarea.value === "") {
        e.preventDefault();
        if (historyIdx < promptHistory.length - 1) {
          historyIdx++;
          aiTextarea.value = promptHistory[historyIdx];
          resizeTextarea(aiTextarea);
        }
        return;
      }
      if (e.key === "ArrowDown" && historyIdx >= 0) {
        e.preventDefault();
        historyIdx--;
        aiTextarea.value = historyIdx >= 0 ? promptHistory[historyIdx] : "";
        resizeTextarea(aiTextarea);
        return;
      }
    });
    aiTextarea.addEventListener("paste", async (e) => {
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of Array.from(items)) {
        if (item.type.startsWith("image/")) {
          e.preventDefault();
          const file = item.getAsFile();
          if (file) await attachImage(file);
          break;
        }
      }
    });
    aiSend.addEventListener("click", () => dispatchAI(aiTextarea));
    aiClearBtn.addEventListener("click", clearConversation);
    aiImgBtn.addEventListener("click", () => aiImgIn.click());
    aiImgIn.addEventListener("change", async () => {
      const file = aiImgIn.files?.[0];
      if (!file) return;
      aiImgIn.value = "";
      await attachImage(file);
    });
    document.getElementById("ai-approve-btn").addEventListener("click", () => {
      if (!pendingAIResp) return;
      send({ type: "aiApprove", response: pendingAIResp, prompt: pendingPrompt });
      hideDiff();
      clearApproval();
    });
    document.getElementById("ai-reject-btn").addEventListener("click", () => {
      send({ type: "aiReject" });
      hideDiff();
      clearApproval();
    });
    document.getElementById("diff-approve-btn").addEventListener("click", () => {
      if (!pendingAIResp) return;
      send({ type: "aiApprove", response: pendingAIResp, prompt: pendingPrompt });
      hideDiff();
      clearApproval();
    });
    document.getElementById("diff-reject-btn").addEventListener("click", () => {
      send({ type: "aiReject" });
      hideDiff();
      clearApproval();
    });
    document.getElementById("undo-btn").addEventListener("click", () => {
      send({ type: "undoLast" });
    });
    const taskInput = document.getElementById("task-add-input");
    const taskAddFn = () => {
      const title = taskInput.value.trim();
      if (!title) return;
      send({
        type: "createTask",
        task: {
          id: generateId(),
          title,
          status: "todo",
          priority: "medium",
          source: "manual",
          created_at: isoNow(),
          updated_at: isoNow()
        }
      });
      taskInput.value = "";
    };
    document.getElementById("task-add-btn").addEventListener("click", taskAddFn);
    taskInput.addEventListener("keydown", (e) => {
      if (e.key === "Enter") {
        e.preventDefault();
        taskAddFn();
      }
    });
    document.getElementById("settings-btn")?.addEventListener("click", () => {
      browser.runtime.getURL && window.open(browser.runtime.getURL("settings/settings.html"));
    });
    document.getElementById("group-dialog").addEventListener("click", (e) => {
      if (e.target === e.currentTarget) {
        e.currentTarget.classList.add("hidden");
      }
    });
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
  function resizeTextarea(el) {
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
  }
  async function attachImage(file) {
    const data = await fileToBase64(file);
    const url = URL.createObjectURL(file);
    pendingImages.push({ data, url });
    const strip = document.getElementById("ai-attachments");
    const thumb = document.createElement("div");
    thumb.className = "ai-thumb";
    const img = document.createElement("img");
    img.src = url;
    const rm = document.createElement("button");
    rm.className = "ai-thumb-rm";
    rm.textContent = "\xD7";
    rm.addEventListener("click", () => {
      pendingImages = pendingImages.filter((p) => p.url !== url);
      URL.revokeObjectURL(url);
      thumb.remove();
    });
    thumb.append(img, rm);
    strip.appendChild(thumb);
  }
  function dispatchAI(textarea) {
    const raw = textarea.value.trim();
    const prompt = raw.replace(/^\/\w+\s*/, (m) => {
      if (raw.startsWith("/remember ")) return "Please remember this: ";
      if (raw.startsWith("/directive ")) return "Follow this instruction going forward: ";
      return m;
    });
    if (!prompt) return;
    document.getElementById("slash-menu").classList.add("hidden");
    promptHistory = [raw, ...promptHistory.filter((h) => h !== raw)].slice(0, 50);
    localStorage.setItem("styl_history", JSON.stringify(promptHistory));
    historyIdx = -1;
    appendChatBubble("user", raw);
    clearApproval();
    textarea.value = "";
    resizeTextarea(textarea);
    const images = [...pendingImages];
    for (const p of images) URL.revokeObjectURL(p.url);
    pendingImages = [];
    document.getElementById("ai-attachments").innerHTML = "";
    if (raw === "!calendar") {
      showThinking();
      send({ type: "calendarRefresh" });
      return;
    }
    showThinking();
    const imageData = images[0]?.data;
    send({ type: "aiCommand", prompt, ...imageData ? { imageData } : {} });
    pendingPrompt = prompt;
  }
  function fileToBase64(file) {
    return new Promise((res, rej) => {
      const reader = new FileReader();
      reader.onload = () => {
        const url = reader.result;
        res(url.split(",")[1] ?? "");
      };
      reader.onerror = rej;
      reader.readAsDataURL(file);
    });
  }
  wireEvents();
  startClock();
  connect();
  loadDailyFocus();
  loadQuote();
  initWallpaper();
})();
//# sourceMappingURL=newtab.js.map
