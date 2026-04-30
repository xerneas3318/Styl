import type { AppState, Task, TaskDiff, AIResponse, TimerMode, TaskStatus, TaskPriority } from '../shared/types';
import { fmt, generateId, isoNow } from '../shared/utils';

// ── Declare globals provided by sound.js & browser extension ─────────────────
declare function playChime(): void;

const RING_C = 2 * Math.PI * 68; // r=68 ≈ 427.26

const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

const QUOTES = [
  'The secret of getting ahead is getting started.',
  'Focus on being productive instead of busy.',
  'Do something today that your future self will thank you for.',
  'Small steps every day lead to big results.',
  'The only way to do great work is to love what you do.',
  'Energy flows where attention goes.',
  'Discipline is choosing between what you want now and what you want most.',
  'Work hard in silence. Let your results make the noise.',
  'Progress, not perfection.',
  'One task at a time. Done well.',
  'Deep work is the ability to focus without distraction.',
  'Create with intention, rest with purpose.',
  'Your future self is watching. Choose well.',
  'The quality of your attention determines the quality of your work.',
  'What you do today can improve all your tomorrows.',
];

// ── State ─────────────────────────────────────────────────────────────────────

let port:          browser.runtime.Port | null = null;
let state:         AppState | null             = null;
let isEditing      = false;
let pendingAIResp: AIResponse | null           = null;
let pendingPrompt  = '';

// ── Chat state ────────────────────────────────────────────────────────────────
let promptHistory: string[]   = JSON.parse(localStorage.getItem('styl_history') ?? '[]');
let historyIdx                = -1;
let pendingImages: Array<{ data: string; url: string }> = [];
let slashActive               = -1;
let thinkingNode: HTMLElement | null = null;

// ── Timer tick ────────────────────────────────────────────────────────────────
let timerTick: ReturnType<typeof setInterval> | null = null;

function liveRemaining(): number {
  const t = state?.timer;
  if (!t) return 0;
  if (!t.isRunning || t.startTime === null) return Math.max(0, t.pausedTimeRemaining);
  const elapsed = Math.floor((Date.now() - t.startTime) / 1000);
  return Math.max(0, t.pausedTimeRemaining - elapsed);
}

function tickTimer() {
  const remaining = liveRemaining();
  if (!isEditing) {
    const el = document.getElementById('time-text');
    if (el) el.textContent = fmt(remaining);
  }
  const total  = state?.timer.sessionTotal ?? 1;
  const offset = (1 - Math.min(1, Math.max(0, total > 0 ? remaining / total : 1))) * RING_C;
  const ring   = document.getElementById('progress-ring') as SVGCircleElement | null;
  if (ring) ring.style.strokeDashoffset = String(offset);
}

function syncTimerTick() {
  if (state?.timer.isRunning) {
    if (!timerTick) timerTick = setInterval(tickTimer, 1000);
  } else {
    if (timerTick) { clearInterval(timerTick); timerTick = null; }
  }
}

// ── Drag-and-drop state ───────────────────────────────────────────────────────
let draggedId: string | null = null;

const SLASH_CMDS = [
  { cmd: '/plan',      desc: 'Reorder tasks by priority & duration',   fill: 'plan my day' },
  { cmd: '/today',     desc: "What's on my calendar today",            fill: "what's on my calendar today?" },
  { cmd: '/week',      desc: 'Show this week\'s schedule',            fill: 'what do I have this week?' },
  { cmd: '/tasks',     desc: 'List all tasks',                        fill: 'list all my tasks' },
  { cmd: '/remember',  desc: 'Tell the AI to remember something',     fill: '/remember ' },
  { cmd: '/directive', desc: 'Set a standing instruction for the AI', fill: '/directive ' },
  { cmd: '/undo',      desc: 'Undo last AI change',                   fill: null },
  { cmd: '/clear',     desc: 'Clear this conversation',               fill: null },
];

// ── Connection ────────────────────────────────────────────────────────────────

function connect() {
  port = browser.runtime.connect({ name: 'newtab' });
  port.onMessage.addListener((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case 'stateUpdate':
        state = msg.state as AppState;
        renderTimer();
        renderTasks();
        renderCalendar(state.calendarCache ?? []);
        renderAddMinBtn();
        syncTimerTick();
        if ((msg as { event?: string }).event === 'timerComplete') playChime();
        break;
      case 'aiThinking':
        showThinking();
        break;
      case 'aiToolUse': {
        const toolInput = msg.input as Record<string, string>;
        const label = msg.tool === 'get_calendar_events'
          ? `Fetching calendar for ${toolInput.start}–${toolInput.end}…`
          : `Using tool: ${msg.tool as string}`;
        appendToolMsg(label);
        break;
      }
      case 'aiComplete':
        removeThinking();
        appendAssistantMsg(msg.message as string, false);
        clearApproval();
        break;
      case 'aiPendingApproval':
        removeThinking();
        pendingAIResp  = msg.response as AIResponse;
        pendingPrompt  = '';
        appendAssistantMsg((msg.response as AIResponse).message, false);
        showDiff(msg.diff as TaskDiff);
        showApproval();
        break;
      case 'aiRejected':
        clearApproval();
        appendAssistantMsg('Cancelled.', false);
        break;
      case 'undoComplete':
        appendAssistantMsg('Done — last change undone.', false);
        break;
      case 'error':
        removeThinking();
        clearApproval();
        appendAssistantMsg(`⚠ ${msg.message as string}`, true);
        break;
      case 'calendarData': {
        const events = msg.events as import('../shared/types').CalendarEvent[];
        const warn   = msg.error as string | undefined;
        renderCalendar(events, warn);
        // If triggered by !calendar debug command, complete the thinking bubble
        if (thinkingNode) {
          removeThinking();
          const summary = events.length
            ? `${events.length} event${events.length !== 1 ? 's' : ''} in the next 14 days.${warn ? '\n⚠ ' + warn : ''}`
            : warn ? `⚠ ${warn}` : 'No upcoming events found.';
          appendAssistantMsg(summary, !!warn && !events.length);
        }
        break;
      }
    }
  });
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 400); });

  // Refresh calendar cache on connect so the strip is populated immediately
  port.postMessage({ type: 'calendarRefresh' });
}

function send(msg: unknown) {
  port?.postMessage(msg);
}

// ── Clock ─────────────────────────────────────────────────────────────────────

function updateClock() {
  const now  = new Date();
  const h    = now.getHours();
  const m    = now.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh   = h % 12 || 12;

  (document.getElementById('clock') as HTMLElement).textContent =
    `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;
  (document.getElementById('date') as HTMLElement).textContent =
    `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;
  (document.getElementById('greeting') as HTMLElement).textContent =
    h >= 5 && h < 12 ? 'Good morning'   :
    h >= 12 && h < 17 ? 'Good afternoon' :
    h >= 17 && h < 21 ? 'Good evening'   : 'Good night';

  const cls =
    h >= 5 && h < 12 ? 'morning'   :
    h >= 12 && h < 17 ? 'afternoon' :
    h >= 17 && h < 21 ? 'evening'   : 'night';
  if (!document.body.classList.contains(cls)) document.body.className = cls;
}

function startClock() {
  updateClock();
  const ms = 1000 - (Date.now() % 1000);
  setTimeout(() => { updateClock(); setInterval(updateClock, 1000); }, ms);
}

// ── Timer rendering ───────────────────────────────────────────────────────────

function renderTimer() {
  if (!state) return;
  const t = state.timer;

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach((el) => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.mode === t.mode);
  });

  // Time display — use liveRemaining() so it's correct even on first render
  if (!isEditing) {
    (document.getElementById('time-text') as HTMLElement).textContent = fmt(liveRemaining());
  }

  // Ring
  const progress = t.sessionTotal > 0 ? liveRemaining() / t.sessionTotal : 1;
  const offset   = (1 - Math.min(1, Math.max(0, progress))) * RING_C;
  const ring = document.getElementById('progress-ring') as SVGCircleElement;
  ring.style.strokeDashoffset = String(offset);
  ring.className.baseVal = 'ring-fg' +
    (t.mode === 'break' ? ' break-mode' : t.mode === 'longBreak' ? ' long-mode' : '');

  // Start/Pause button
  (document.getElementById('start-pause-btn') as HTMLElement).textContent =
    t.isRunning ? 'Pause' : 'Start';

  // Session dots
  const dots  = document.getElementById('sessions-dots') as HTMLElement;
  dots.innerHTML = '';
  const pos  = t.sessionsCompleted % 4;
  for (let i = 0; i < 4; i++) {
    const d = document.createElement('div');
    d.className = 's-dot' + (i < pos ? ' filled' : '');
    dots.appendChild(d);
  }
  (document.getElementById('sessions-label') as HTMLElement).textContent =
    `${t.sessionsCompleted} session${t.sessionsCompleted !== 1 ? 's' : ''} completed`;
}

function renderAddMinBtn() {
  const btn = document.getElementById('add-min-btn') as HTMLElement;
  btn.classList.toggle('hidden', !(state?.timer.isRunning));
}

// ── Timer controls ─────────────────────────────────────────────────────────────

function enterEditMode() {
  if (isEditing || !state) return;
  isEditing = true;
  if (state.timer.isRunning) send({ type: 'timerPause' });

  const mode    = state.timer.mode;
  const minutes = Math.round(state.timer.pausedTimeRemaining / 60);

  (document.getElementById('time-text')   as HTMLElement).classList.add('hidden');
  (document.getElementById('time-editor') as HTMLElement).classList.remove('hidden');
  const input = document.getElementById('time-edit') as HTMLInputElement;
  input.value = String(minutes);
  input.focus();
  input.select();

  buildPresets(mode, minutes);
  (document.getElementById('preset-bar') as HTMLElement).classList.remove('hidden');
}

function exitEditMode(save = true) {
  if (!isEditing) return;
  isEditing = false;
  if (save) {
    const raw = parseInt((document.getElementById('time-edit') as HTMLInputElement).value, 10);
    const min = isNaN(raw) ? null : Math.min(Math.max(raw, 1), 180);
    if (min) saveMinutes(min);
  }
  (document.getElementById('time-text')   as HTMLElement).classList.remove('hidden');
  (document.getElementById('time-editor') as HTMLElement).classList.add('hidden');
  (document.getElementById('preset-bar') as HTMLElement).classList.add('hidden');
}

function saveMinutes(minutes: number) {
  const secs = minutes * 60;
  const mode = state?.timer.mode ?? 'focus';
  send({
    type:              'timerUpdateSettings',
    focusDuration:     mode === 'focus'     ? secs : state?.timer.focusDuration,
    breakDuration:     mode === 'break'     ? secs : state?.timer.breakDuration,
    longBreakDuration: mode === 'longBreak' ? secs : state?.timer.longBreakDuration,
  });
}

function buildPresets(mode: TimerMode, current: number) {
  const PRESETS: Record<TimerMode, number[]> = {
    focus:     [15, 20, 25, 30, 45, 60, 90],
    break:     [5, 10, 15],
    longBreak: [10, 15, 20, 25, 30],
  };
  const bar = document.getElementById('preset-bar') as HTMLElement;
  bar.innerHTML = '';
  PRESETS[mode].forEach((val) => {
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (val === current ? ' active' : '');
    chip.textContent = `${val}m`;
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', () => {
      (document.getElementById('time-edit') as HTMLInputElement).value = String(val);
      exitEditMode(true);
    });
    bar.appendChild(chip);
  });
}

// ── Task rendering ────────────────────────────────────────────────────────────

const collapsedGroups = new Set<string>(
  JSON.parse(localStorage.getItem('styl_collapsed_groups') ?? '[]') as string[]
);

function toggleGroup(project: string) {
  if (collapsedGroups.has(project)) collapsedGroups.delete(project);
  else                              collapsedGroups.add(project);
  localStorage.setItem('styl_collapsed_groups', JSON.stringify([...collapsedGroups]));
  renderTasks();
}

function renderTasks() {
  const tasks = state?.tasks ?? [];
  const list  = document.getElementById('task-list') as HTMLElement;
  list.innerHTML = '';

  if (tasks.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'task-empty';
    empty.textContent = 'No tasks — add one or ask the AI.';
    list.appendChild(empty);
    return;
  }

  // Split into ungrouped and grouped
  const groups  = new Map<string, Task[]>();
  const noGroup: Task[] = [];
  for (const t of tasks) {
    if (t.project) {
      if (!groups.has(t.project)) groups.set(t.project, []);
      groups.get(t.project)!.push(t);
    } else {
      noGroup.push(t);
    }
  }

  // Ungrouped tasks first (no header needed)
  for (const t of noGroup) list.appendChild(buildTaskItem(t));

  // Groups sorted alphabetically
  for (const [project, gtasks] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    const collapsed = collapsedGroups.has(project);
    const done      = gtasks.filter((t) => t.status === 'done').length;

    const header = document.createElement('div');
    header.className = 'task-group-header';
    header.addEventListener('click', () => toggleGroup(project));

    const arrow = document.createElement('span');
    arrow.className   = 'task-group-arrow';
    arrow.textContent = collapsed ? '▶' : '▼';

    const label = document.createElement('span');
    label.className   = 'task-group-label';
    label.textContent = project;

    const badge = document.createElement('span');
    badge.className   = 'task-group-badge';
    badge.textContent = `${done}/${gtasks.length}`;

    header.append(arrow, label, badge);
    list.appendChild(header);

    if (!collapsed) {
      for (const t of gtasks) list.appendChild(buildTaskItem(t));
    }
  }
}

function buildTaskItem(task: Task): HTMLElement {
  const row = document.createElement('div');
  row.className = `task-item ${task.status === 'done' ? 'done' : ''}`;
  row.dataset.id = task.id;
  row.draggable  = true;

  // ── Drag-and-drop ──
  row.addEventListener('dragstart', (e) => {
    draggedId = task.id;
    row.classList.add('dragging');
    e.dataTransfer!.effectAllowed = 'move';
    e.dataTransfer!.setData('text/plain', task.id);
  });

  row.addEventListener('dragend', () => {
    draggedId = null;
    row.classList.remove('dragging');
    clearDragIndicators();
  });

  row.addEventListener('dragover', (e) => {
    e.preventDefault();
    if (draggedId === task.id) return;
    e.dataTransfer!.dropEffect = 'move';
    clearDragIndicators();
    const rect = row.getBoundingClientRect();
    const y    = e.clientY - rect.top;
    const h    = rect.height;
    if (y < h * 0.33)      row.classList.add('drag-over-top');
    else if (y > h * 0.67) row.classList.add('drag-over-bottom');
    else                   row.classList.add('drag-over-center');
  });

  row.addEventListener('dragleave', (e) => {
    if (!row.contains(e.relatedTarget as Node)) {
      row.classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-center');
    }
  });

  row.addEventListener('drop', (e) => {
    e.preventDefault();
    if (!draggedId || draggedId === task.id) { clearDragIndicators(); return; }
    const id = draggedId;
    const isCenter = row.classList.contains('drag-over-center');
    const isBefore = row.classList.contains('drag-over-top');
    clearDragIndicators();
    if (isCenter) showGroupDialog(id, task.id);
    else          reorderTask(id, task.id, isBefore ? 'before' : 'after');
  });

  // Priority dot — click to cycle low → medium → high → low
  const PRIORITIES: TaskPriority[] = ['low', 'medium', 'high'];
  const dot = document.createElement('span');
  dot.className = `task-dot priority-${task.priority}`;
  dot.title     = `Priority: ${task.priority} (click to change)`;
  dot.style.cursor = 'pointer';
  dot.addEventListener('click', (e) => {
    e.stopPropagation();
    const next = PRIORITIES[(PRIORITIES.indexOf(task.priority) + 1) % PRIORITIES.length];
    send({ type: 'updateTask', task: { ...task, priority: next, updated_at: isoNow() } });
  });

  // Checkbox
  const cb = document.createElement('input');
  cb.type      = 'checkbox';
  cb.checked   = task.status === 'done';
  cb.className = 'task-cb';
  cb.addEventListener('change', () => {
    send({ type: 'updateTask', task: { ...task, status: cb.checked ? 'done' : 'todo', updated_at: isoNow() } });
  });

  // Title
  const title = document.createElement('span');
  title.className   = 'task-title-text';
  title.textContent = task.title;
  title.addEventListener('click', () => startInlineEdit(task, title));

  // Duration badge
  const dur = document.createElement('span');
  dur.className   = 'task-dur';
  dur.textContent = task.estimated_duration_minutes ? `${task.estimated_duration_minutes}m` : '';

  // Group tag
  const grp = document.createElement('span');
  grp.className   = `task-group-tag${task.project ? ' has-group' : ''}`;
  grp.textContent = task.project ?? '＋';
  grp.title       = task.project ? `Group: ${task.project} (click to change)` : 'Add to group';
  grp.addEventListener('click', (e) => { e.stopPropagation(); startGroupEdit(task, grp); });

  // Delete
  const del = document.createElement('button');
  del.className   = 'task-del';
  del.textContent = '×';
  del.title       = 'Delete';
  del.addEventListener('click', () => send({ type: 'deleteTask', id: task.id }));

  row.append(dot, cb, title, dur, grp, del);
  return row;
}

// ── Drag-and-drop helpers ─────────────────────────────────────────────────────

function clearDragIndicators() {
  document.querySelectorAll('.task-item').forEach((el) => {
    (el as HTMLElement).classList.remove('drag-over-top', 'drag-over-bottom', 'drag-over-center');
  });
}

function reorderTask(fromId: string, targetId: string, position: 'before' | 'after') {
  const items = Array.from(document.querySelectorAll<HTMLElement>('.task-item[data-id]'));
  const ids   = items.map((el) => el.dataset.id!);

  const fromIdx = ids.indexOf(fromId);
  if (fromIdx === -1) return;
  ids.splice(fromIdx, 1);                         // remove from current spot
  const toIdx = ids.indexOf(targetId);
  if (toIdx === -1) return;
  ids.splice(position === 'before' ? toIdx : toIdx + 1, 0, fromId); // insert
  send({ type: 'reorderTasks', ids });
}

function showGroupDialog(id1: string, id2: string) {
  const overlay = document.getElementById('group-dialog') as HTMLElement;
  const input   = document.getElementById('group-dialog-input') as HTMLInputElement;

  const task1 = state?.tasks.find((t) => t.id === id1);
  const task2 = state?.tasks.find((t) => t.id === id2);
  input.value = task1?.project ?? task2?.project ?? '';
  overlay.classList.remove('hidden');
  input.focus();
  input.select();

  const commit = (name: string | null) => {
    overlay.classList.add('hidden');
    input.onkeydown = null;
    if (name !== null) {
      const project = name.trim() || undefined;
      [task1, task2].forEach((t) => {
        if (t) send({ type: 'updateTask', task: { ...t, project, updated_at: isoNow() } });
      });
    }
  };

  (document.getElementById('group-dialog-confirm') as HTMLElement).onclick = () => commit(input.value);
  (document.getElementById('group-dialog-cancel')  as HTMLElement).onclick = () => commit(null);
  input.onkeydown = (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); commit(input.value); }
    if (e.key === 'Escape') commit(null);
  };
}

// ── Group edit ────────────────────────────────────────────────────────────────

function startGroupEdit(task: Task, el: HTMLElement) {
  const input = document.createElement('input');
  input.className   = 'task-group-edit';
  input.value       = task.project ?? '';
  input.placeholder = 'Group…';
  el.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const project = input.value.trim() || undefined;
    send({ type: 'updateTask', task: { ...task, project, updated_at: isoNow() } });
  };
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = task.project ?? ''; input.blur(); }
  });
}

function startInlineEdit(task: Task, el: HTMLElement) {
  const input = document.createElement('input');
  input.className = 'task-inline-edit';
  input.value = task.title;
  el.replaceWith(input);
  input.focus();
  input.select();

  const commit = () => {
    const title = input.value.trim();
    if (title && title !== task.title) {
      send({ type: 'updateTask', task: { ...task, title, updated_at: isoNow() } });
    } else {
      renderTasks(); // revert
    }
  };
  input.addEventListener('blur',    commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { input.value = task.title; input.blur(); }
  });
}

// ── Calendar panel ────────────────────────────────────────────────────────────

type CalView = 'day' | 'week';
let calView:   CalView = 'day';
let calEvents: import('../shared/types').CalendarEvent[] = [];
let calWarn:   string | undefined;

function renderCalendar(events: import('../shared/types').CalendarEvent[], warn?: string) {
  calEvents = events;
  calWarn   = warn;

  const panel  = document.getElementById('cal-panel') as HTMLElement;
  const body   = document.getElementById('cal-body')  as HTMLElement;
  const dateEl = document.getElementById('cal-header-date') as HTMLElement;

  // Keep tab highlight in sync
  document.querySelectorAll('.cal-tab').forEach((el) => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.view === calView);
  });

  if (!events.length && !warn) { panel.classList.add('hidden'); return; }
  panel.classList.remove('hidden');
  body.innerHTML = '';

  if (warn) {
    const warnEl = document.createElement('div');
    warnEl.className = 'cal-warn';
    warnEl.textContent = `⚠ ${warn}`;
    body.appendChild(warnEl);
  }

  if (calView === 'day') renderDayView(events, body, dateEl);
  else                   renderWeekView(events, body, dateEl);
}

function calStartDt(e: import('../shared/types').CalendarEvent): Date {
  if (!e.start.includes('T')) {
    const [y, m, d] = e.start.split('-').map(Number);
    return new Date(y, m - 1, d, 12);
  }
  return new Date(e.start);
}

function calTimeLabel(e: import('../shared/types').CalendarEvent, startDt: Date): string {
  return !e.start.includes('T')
    ? 'All day'
    : startDt.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

function calEventRow(timeText: string, titleText: string): HTMLElement {
  const row = document.createElement('div');
  row.className = 'cal-event-row';
  const timeEl = document.createElement('span');
  timeEl.className   = 'cal-event-time';
  timeEl.textContent = timeText;
  const titleEl = document.createElement('span');
  titleEl.className   = 'cal-event-title';
  titleEl.textContent = titleText;
  titleEl.title       = titleText;
  row.append(timeEl, titleEl);
  return row;
}

function renderDayView(
  events:  import('../shared/types').CalendarEvent[],
  body:    HTMLElement,
  dateEl:  HTMLElement,
) {
  const now      = new Date();
  const todayKey = ymd(now);

  dateEl.textContent = now.toLocaleDateString('en-US', {
    weekday: 'long', month: 'long', day: 'numeric',
  });

  const todayEvents = events.filter((e) => ymd(calStartDt(e)) === todayKey);

  if (!todayEvents.length) {
    const empty = document.createElement('div');
    empty.className   = 'cal-empty';
    empty.textContent = 'Nothing scheduled for today';
    body.appendChild(empty);
    return;
  }

  for (const e of todayEvents) {
    const dt = calStartDt(e);
    body.appendChild(calEventRow(calTimeLabel(e, dt), e.title));
  }
}

function renderWeekView(
  events:  import('../shared/types').CalendarEvent[],
  body:    HTMLElement,
  dateEl:  HTMLElement,
) {
  const now = new Date();

  // Build a map for the next 7 days
  type DaySlot = { label: string; isToday: boolean; rows: import('../shared/types').CalendarEvent[] };
  const slots = new Map<string, DaySlot>();
  for (let i = 0; i < 7; i++) {
    const d = new Date(now); d.setDate(now.getDate() + i);
    const key   = ymd(d);
    const label = i === 0 ? 'Today'
      : i === 1 ? 'Tomorrow'
      : d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    slots.set(key, { label, isToday: i === 0, rows: [] });
  }

  for (const e of events) {
    const key = ymd(calStartDt(e));
    slots.get(key)?.rows.push(e);
  }

  // Date range label in header
  const last = new Date(now); last.setDate(now.getDate() + 6);
  dateEl.textContent =
    `${now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ` +
    last.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  let hasAny = false;
  for (const [, slot] of slots) {
    if (!slot.rows.length) continue;
    hasAny = true;

    const group = document.createElement('div');
    group.className = 'cal-day-group';

    const label = document.createElement('div');
    label.className   = `cal-day-label${slot.isToday ? ' today-label' : ''}`;
    label.textContent = slot.label;
    group.appendChild(label);

    for (const e of slot.rows) {
      const dt = calStartDt(e);
      group.appendChild(calEventRow(calTimeLabel(e, dt), e.title));
    }

    body.appendChild(group);
  }

  if (!hasAny) {
    const empty = document.createElement('div');
    empty.className   = 'cal-empty';
    empty.textContent = 'Nothing scheduled this week';
    body.appendChild(empty);
  }
}

function ymd(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
}

// ── AI chat system ────────────────────────────────────────────────────────────

function chatMsgs(): HTMLElement { return document.getElementById('ai-messages') as HTMLElement; }

function scrollToBottom() {
  const el = chatMsgs();
  el.scrollTop = el.scrollHeight;
}

function removeEmptyState() {
  document.getElementById('ai-empty')?.remove();
}

function appendChatBubble(role: 'user' | 'assistant' | 'tool', text: string, isError = false): HTMLElement {
  removeEmptyState();
  const msgs = chatMsgs();
  const wrap = document.createElement('div');
  wrap.className = `chat-msg ${role}${isError ? ' error' : ''}`;
  const bubble = document.createElement('div');
  bubble.className   = 'chat-bubble';
  bubble.textContent = text;
  wrap.appendChild(bubble);
  msgs.appendChild(wrap);
  scrollToBottom();
  return wrap;
}

function appendAssistantMsg(text: string, isError: boolean) {
  appendChatBubble('assistant', text, isError);
}

function appendToolMsg(text: string) {
  appendChatBubble('tool', text);
}

function showThinking() {
  if (thinkingNode) return;  // already visible — don't create a second one
  removeEmptyState();
  const msgs = chatMsgs();
  const wrap = document.createElement('div');
  wrap.className = 'chat-msg assistant';
  wrap.id        = 'ai-thinking-node';
  const bubble = document.createElement('div');
  bubble.className = 'chat-thinking';
  bubble.innerHTML =
    '<span>Thinking</span>' +
    '<div class="thinking-dots">' +
    '<div class="thinking-dot"></div>' +
    '<div class="thinking-dot"></div>' +
    '<div class="thinking-dot"></div>' +
    '</div>';
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
  (document.getElementById('ai-actions') as HTMLElement).classList.remove('hidden');
}

function clearApproval() {
  (document.getElementById('ai-actions') as HTMLElement).classList.add('hidden');
  pendingAIResp = null;
}

function clearConversation() {
  const msgs = chatMsgs();
  msgs.innerHTML = '';
  // Re-insert empty state
  const empty = document.createElement('div');
  empty.className = 'ai-empty';
  empty.id        = 'ai-empty';
  empty.innerHTML =
    '<div class="ai-empty-icon">✦</div>' +
    '<div class="ai-empty-hints">' +
    '<span>Type <kbd>/</kbd> for commands</span>' +
    '<span class="ai-hint-sep">·</span>' +
    '<span>Paste images with <kbd>⌘V</kbd></span>' +
    '</div>';
  msgs.appendChild(empty);
  thinkingNode  = null;
  pendingAIResp = null;
  clearApproval();
}

// ── Slash command menu ────────────────────────────────────────────────────────

function updateSlashMenu(value: string) {
  const menu     = document.getElementById('slash-menu') as HTMLElement;
  const textarea = document.getElementById('ai-input')   as HTMLTextAreaElement;

  if (!value.startsWith('/')) {
    menu.classList.add('hidden');
    slashActive = -1;
    return;
  }

  const q       = value.toLowerCase();
  const matches = SLASH_CMDS.filter((c) => c.cmd.startsWith(q));

  if (!matches.length) { menu.classList.add('hidden'); slashActive = -1; return; }

  menu.classList.remove('hidden');
  menu.innerHTML = '';
  if (slashActive >= matches.length) slashActive = 0;

  matches.forEach((cmd, i) => {
    const item = document.createElement('div');
    item.className = `slash-item${i === slashActive ? ' active' : ''}`;

    const cmdEl = document.createElement('span');
    cmdEl.className   = 'slash-cmd';
    cmdEl.textContent = cmd.cmd;

    const descEl = document.createElement('span');
    descEl.className   = 'slash-desc';
    descEl.textContent = cmd.desc;

    item.append(cmdEl, descEl);
    item.addEventListener('mousedown', (e) => { e.preventDefault(); selectSlashCmd(cmd, textarea); });
    menu.appendChild(item);
  });
}

function selectSlashCmd(cmd: typeof SLASH_CMDS[0], textarea: HTMLTextAreaElement) {
  const menu = document.getElementById('slash-menu') as HTMLElement;
  menu.classList.add('hidden');
  slashActive = -1;

  if (cmd.fill === null) {
    // Immediate actions
    if (cmd.cmd === '/clear') { clearConversation(); textarea.value = ''; return; }
    if (cmd.cmd === '/undo')  { send({ type: 'undoLast' }); textarea.value = ''; return; }
    return;
  }

  textarea.value = cmd.fill;
  textarea.focus();
  resizeTextarea(textarea);

  // If fill ends with space, cursor goes to end (user completes the prompt)
  // Otherwise dispatch immediately
  if (!cmd.fill.endsWith(' ')) {
    dispatchAI(textarea);
  }
}

function showDiff(diff: TaskDiff) {
  const overlay = document.getElementById('diff-overlay') as HTMLElement;
  const content = document.getElementById('diff-content') as HTMLElement;
  content.innerHTML = '';

  const section = (label: string, items: Task[], cls: string) => {
    if (!items.length) return;
    const h = document.createElement('div');
    h.className = 'diff-section-label';
    h.textContent = label;
    content.appendChild(h);
    items.forEach((t) => {
      const row = document.createElement('div');
      row.className = `diff-row ${cls}`;
      row.textContent = t.title;
      content.appendChild(row);
    });
  };

  section('Added', diff.added,   'diff-add');
  section('Removed', diff.removed, 'diff-rem');
  diff.modified.forEach(({ before, after }) => {
    const row = document.createElement('div');
    row.className = 'diff-row diff-mod';
    row.textContent = `${before.title} → ${after.title}`;
    content.appendChild(row);
  });

  if (!diff.added.length && !diff.removed.length && !diff.modified.length) {
    content.textContent = 'No task changes.';
  }

  overlay.classList.remove('hidden');
}

function hideDiff() {
  (document.getElementById('diff-overlay') as HTMLElement).classList.add('hidden');
}

// ── Quote ─────────────────────────────────────────────────────────────────────

function loadQuote() {
  const idx = Math.floor(Date.now() / 86_400_000) % QUOTES.length;
  (document.getElementById('quote') as HTMLElement).textContent = `"${QUOTES[idx]}"`;
}

// ── Daily focus ───────────────────────────────────────────────────────────────

function loadDailyFocus() {
  const today    = new Date().toDateString();
  const savedDay = localStorage.getItem('styl_focus_date');
  const savedVal = localStorage.getItem('styl_focus_text');
  const input    = document.getElementById('focus-input') as HTMLInputElement;
  if (savedDay === today && savedVal) input.value = savedVal;
  else { localStorage.removeItem('styl_focus_text'); localStorage.setItem('styl_focus_date', today); }
}

// ── Wallpaper ─────────────────────────────────────────────────────────────────

const DB_NAME    = 'styl';
const DB_STORE   = 'wallpaper';
let   _db: IDBDatabase | null = null;
let   _wpUrl: string | null   = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(DB_STORE);
    req.onsuccess  = () => { _db = req.result; res(_db); };
    req.onerror    = () => rej(req.error);
  });
}

async function wpSave(blob: Blob) {
  const db = await openDB();
  return new Promise<void>((res, rej) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).put(blob, 'img');
    tx.oncomplete = () => res();
    tx.onerror    = () => rej(tx.error);
  });
}

async function wpLoad(): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((res) => {
    const tx  = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get('img');
    req.onsuccess = () => res(req.result as Blob | null);
    req.onerror   = () => res(null);
  });
}

async function wpClear() {
  const db = await openDB();
  return new Promise<void>((res) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete('img');
    tx.oncomplete = () => res();
    tx.onerror    = () => res();
  });
}

function applyBlob(blob: Blob) {
  if (_wpUrl) URL.revokeObjectURL(_wpUrl);
  _wpUrl = URL.createObjectURL(blob);
  document.body.style.backgroundImage = `url(${_wpUrl})`;
  document.body.classList.add('has-wallpaper');
  (document.getElementById('wallpaper-remove-btn') as HTMLElement).classList.remove('hidden');
}

function removeWallpaper() {
  if (_wpUrl) { URL.revokeObjectURL(_wpUrl); _wpUrl = null; }
  document.body.style.backgroundImage = '';
  document.body.classList.remove('has-wallpaper');
  (document.getElementById('wallpaper-remove-btn') as HTMLElement).classList.add('hidden');
  wpClear();
}

async function initWallpaper() {
  const blob = await wpLoad();
  if (blob) applyBlob(blob);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wireEvents() {
  // Timer
  document.getElementById('time-text')!.addEventListener('click', enterEditMode);
  (document.getElementById('time-edit') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); exitEditMode(true); }
    if (e.key === 'Escape') exitEditMode(false);
  });
  (document.getElementById('time-edit') as HTMLInputElement).addEventListener('blur', () => {
    setTimeout(() => { if (isEditing) exitEditMode(true); }, 150);
  });
  document.querySelectorAll('.mode-tab').forEach((el) => {
    el.addEventListener('click', () =>
      send({ type: 'timerSetMode', mode: (el as HTMLElement).dataset.mode as TimerMode })
    );
  });
  document.getElementById('start-pause-btn')!.addEventListener('click', () => {
    if (!state) return;
    send({ type: state.timer.isRunning ? 'timerPause' : 'timerStart' });
  });
  document.getElementById('reset-btn')!.addEventListener('click', () => send({ type: 'timerReset' }));
  document.getElementById('skip-btn')!.addEventListener('click',  () => send({ type: 'timerSkip' }));
  document.getElementById('add-min-btn')!.addEventListener('click', () => send({ type: 'timerAddMinute' }));

  // Calendar view tabs
  document.querySelectorAll('.cal-tab').forEach((el) => {
    el.addEventListener('click', () => {
      calView = (el as HTMLElement).dataset.view as CalView;
      renderCalendar(calEvents, calWarn);
    });
  });

  // Focus input
  const focusInput = document.getElementById('focus-input') as HTMLInputElement;
  focusInput.addEventListener('input', () =>
    localStorage.setItem('styl_focus_text', focusInput.value)
  );

  // AI panel
  const aiTextarea = document.getElementById('ai-input')   as HTMLTextAreaElement;
  const aiSend     = document.getElementById('ai-send')    as HTMLButtonElement;
  const aiImgIn    = document.getElementById('ai-img')     as HTMLInputElement;
  const aiImgBtn   = document.getElementById('ai-img-btn') as HTMLButtonElement;
  const aiClearBtn = document.getElementById('ai-clear-btn') as HTMLButtonElement;

  aiTextarea.addEventListener('input', () => {
    resizeTextarea(aiTextarea);
    updateSlashMenu(aiTextarea.value);
  });

  aiTextarea.addEventListener('keydown', (e) => {
    const menu = document.getElementById('slash-menu') as HTMLElement;
    const menuVisible = !menu.classList.contains('hidden');
    const q    = aiTextarea.value.toLowerCase();
    const matches = SLASH_CMDS.filter((c) => c.cmd.startsWith(q));

    if (menuVisible) {
      if (e.key === 'ArrowDown') { e.preventDefault(); slashActive = (slashActive + 1) % matches.length; updateSlashMenu(aiTextarea.value); return; }
      if (e.key === 'ArrowUp')   { e.preventDefault(); slashActive = (slashActive - 1 + matches.length) % matches.length; updateSlashMenu(aiTextarea.value); return; }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        const chosen = matches[slashActive >= 0 ? slashActive : 0];
        if (chosen) selectSlashCmd(chosen, aiTextarea);
        return;
      }
      if (e.key === 'Escape') { menu.classList.add('hidden'); slashActive = -1; return; }
    }

    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dispatchAI(aiTextarea); return; }

    // Up/Down arrow to cycle through prompt history when input is empty
    if (e.key === 'ArrowUp' && aiTextarea.value === '') {
      e.preventDefault();
      if (historyIdx < promptHistory.length - 1) {
        historyIdx++;
        aiTextarea.value = promptHistory[historyIdx];
        resizeTextarea(aiTextarea);
      }
      return;
    }
    if (e.key === 'ArrowDown' && historyIdx >= 0) {
      e.preventDefault();
      historyIdx--;
      aiTextarea.value = historyIdx >= 0 ? promptHistory[historyIdx] : '';
      resizeTextarea(aiTextarea);
      return;
    }
  });

  // Paste image from clipboard (⌘V / Ctrl+V)
  aiTextarea.addEventListener('paste', async (e) => {
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of Array.from(items)) {
      if (item.type.startsWith('image/')) {
        e.preventDefault();
        const file = item.getAsFile();
        if (file) await attachImage(file);
        break;
      }
    }
  });

  aiSend.addEventListener('click', () => dispatchAI(aiTextarea));
  aiClearBtn.addEventListener('click', clearConversation);

  aiImgBtn.addEventListener('click', () => aiImgIn.click());
  aiImgIn.addEventListener('change', async () => {
    const file = aiImgIn.files?.[0];
    if (!file) return;
    aiImgIn.value = '';
    await attachImage(file);
  });

  // AI approve / reject
  document.getElementById('ai-approve-btn')!.addEventListener('click', () => {
    if (!pendingAIResp) return;
    send({ type: 'aiApprove', response: pendingAIResp, prompt: pendingPrompt });
    hideDiff(); clearApproval();
  });
  document.getElementById('ai-reject-btn')!.addEventListener('click', () => {
    send({ type: 'aiReject' });
    hideDiff(); clearApproval();
  });
  document.getElementById('diff-approve-btn')!.addEventListener('click', () => {
    if (!pendingAIResp) return;
    send({ type: 'aiApprove', response: pendingAIResp, prompt: pendingPrompt });
    hideDiff(); clearApproval();
  });
  document.getElementById('diff-reject-btn')!.addEventListener('click', () => {
    send({ type: 'aiReject' });
    hideDiff(); clearApproval();
  });

  // Undo
  document.getElementById('undo-btn')!.addEventListener('click', () => {
    send({ type: 'undoLast' });
  });

  // Task add
  const taskInput = document.getElementById('task-add-input') as HTMLInputElement;
  const taskAddFn = () => {
    const title = taskInput.value.trim();
    if (!title) return;
    send({
      type: 'createTask',
      task: {
        id: generateId(), title,
        status: 'todo' as TaskStatus, priority: 'medium' as TaskPriority,
        source: 'manual', created_at: isoNow(), updated_at: isoNow(),
      },
    });
    taskInput.value = '';
  };
  document.getElementById('task-add-btn')!.addEventListener('click', taskAddFn);
  taskInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); taskAddFn(); }
  });

  // Settings link
  document.getElementById('settings-btn')?.addEventListener('click', () => {
    browser.runtime.getURL && window.open(browser.runtime.getURL('settings/settings.html'));
  });

  // Group dialog — dismiss on overlay click
  document.getElementById('group-dialog')!.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) {
      (e.currentTarget as HTMLElement).classList.add('hidden');
    }
  });

  // Wallpaper
  const wpFile = document.getElementById('wallpaper-file') as HTMLInputElement;
  document.getElementById('wallpaper-upload-btn')!.addEventListener('click', () => wpFile.click());
  wpFile.addEventListener('change', async () => {
    const file = wpFile.files?.[0];
    if (!file) return;
    wpFile.value = '';
    await wpSave(file);
    applyBlob(file);
  });
  document.getElementById('wallpaper-remove-btn')!.addEventListener('click', removeWallpaper);
}

// ── AI dispatch helpers ───────────────────────────────────────────────────────

function resizeTextarea(el: HTMLTextAreaElement) {
  el.style.height = 'auto';
  el.style.height = `${Math.min(el.scrollHeight, 110)}px`;
}

async function attachImage(file: File) {
  const data      = await fileToBase64(file);
  const url       = URL.createObjectURL(file);
  pendingImages.push({ data, url });

  const strip = document.getElementById('ai-attachments') as HTMLElement;
  const thumb = document.createElement('div');
  thumb.className = 'ai-thumb';
  const img = document.createElement('img');
  img.src = url;
  const rm = document.createElement('button');
  rm.className   = 'ai-thumb-rm';
  rm.textContent = '×';
  rm.addEventListener('click', () => {
    pendingImages = pendingImages.filter((p) => p.url !== url);
    URL.revokeObjectURL(url);
    thumb.remove();
  });
  thumb.append(img, rm);
  strip.appendChild(thumb);
}

function dispatchAI(textarea: HTMLTextAreaElement) {
  const raw    = textarea.value.trim();
  const prompt = raw.replace(/^\/\w+\s*/, (m) => {
    // Handle /remember and /directive by keeping their content
    if (raw.startsWith('/remember '))  return 'Please remember this: ';
    if (raw.startsWith('/directive ')) return 'Follow this instruction going forward: ';
    return m;  // other slash commands were handled by selectSlashCmd
  });
  if (!prompt) return;

  document.getElementById('slash-menu')!.classList.add('hidden');

  // Save to history (deduplicated, cap at 50)
  promptHistory = [raw, ...promptHistory.filter((h) => h !== raw)].slice(0, 50);
  localStorage.setItem('styl_history', JSON.stringify(promptHistory));
  historyIdx = -1;

  appendChatBubble('user', raw);
  clearApproval();
  textarea.value = '';
  resizeTextarea(textarea);

  // Revoke object URLs and clear attachment strip after grabbing data
  const images = [...pendingImages];
  for (const p of images) URL.revokeObjectURL(p.url);
  pendingImages = [];
  (document.getElementById('ai-attachments') as HTMLElement).innerHTML = '';

  // !calendar debug shortcut
  if (raw === '!calendar') {
    showThinking();
    send({ type: 'calendarRefresh' });
    return;
  }

  showThinking();
  const imageData = images[0]?.data;
  send({ type: 'aiCommand', prompt, ...(imageData ? { imageData } : {}) });
  pendingPrompt = prompt;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fileToBase64(file: File): Promise<string> {
  return new Promise((res, rej) => {
    const reader = new FileReader();
    reader.onload  = () => {
      const url = reader.result as string;
      res(url.split(',')[1] ?? '');
    };
    reader.onerror = rej;
    reader.readAsDataURL(file);
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────────

wireEvents();
startClock();
connect();
loadDailyFocus();
loadQuote();
initWallpaper();
