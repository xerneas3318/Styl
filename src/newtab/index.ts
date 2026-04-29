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

// ── Connection ────────────────────────────────────────────────────────────────

function connect() {
  port = browser.runtime.connect({ name: 'newtab' });
  port.onMessage.addListener((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case 'stateUpdate':
        state = msg.state as AppState;
        renderTimer();
        renderTasks();
        renderAddMinBtn();
        if ((msg as { event?: string }).event === 'timerComplete') playChime();
        break;
      case 'aiThinking':   showAIThinking();   break;
      case 'aiComplete':   showAIMsg(msg.message as string, false); clearAIActions(); break;
      case 'aiPendingApproval':
        pendingAIResp = msg.response as AIResponse;
        pendingPrompt = (document.getElementById('ai-input') as HTMLInputElement).value;
        showAIMsg((msg.response as AIResponse).message, false);
        showDiff(msg.diff as TaskDiff);
        showAIActions();
        break;
      case 'aiRejected':   clearAIActions(); showAIMsg('Cancelled.', false); break;
      case 'undoComplete': showAIMsg('Undone.', false); break;
      case 'error':        showAIMsg(`⚠ ${msg.message as string}`, true); clearAIActions(); break;
    }
  });
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 400); });
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

  // Time display
  if (!isEditing) {
    (document.getElementById('time-text') as HTMLElement).textContent = fmt(t.pausedTimeRemaining);
  }

  // Ring
  const progress = t.sessionTotal > 0 ? t.pausedTimeRemaining / t.sessionTotal : 1;
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

  tasks.forEach((task) => {
    const item = buildTaskItem(task);
    list.appendChild(item);
  });
}

function buildTaskItem(task: Task): HTMLElement {
  const row = document.createElement('div');
  row.className = `task-item ${task.status === 'done' ? 'done' : ''}`;
  row.dataset.id = task.id;

  // Priority dot
  const dot = document.createElement('span');
  dot.className = `task-dot priority-${task.priority}`;
  dot.title = task.priority;

  // Checkbox
  const cb = document.createElement('input');
  cb.type    = 'checkbox';
  cb.checked = task.status === 'done';
  cb.className = 'task-cb';
  cb.addEventListener('change', () => {
    send({
      type: 'updateTask',
      task: { ...task, status: cb.checked ? 'done' : 'todo', updated_at: isoNow() },
    });
  });

  // Title
  const title = document.createElement('span');
  title.className = 'task-title-text';
  title.textContent = task.title;
  title.addEventListener('click', () => startInlineEdit(task, title));

  // Duration badge
  const dur = document.createElement('span');
  dur.className = 'task-dur';
  dur.textContent = task.estimated_duration_minutes ? `${task.estimated_duration_minutes}m` : '';

  // Delete
  const del = document.createElement('button');
  del.className = 'task-del';
  del.textContent = '×';
  del.title = 'Delete';
  del.addEventListener('click', () => send({ type: 'deleteTask', id: task.id }));

  row.append(dot, cb, title, dur, del);
  return row;
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

// ── AI command bar ────────────────────────────────────────────────────────────

function showAIThinking() {
  const resp = document.getElementById('ai-response') as HTMLElement;
  resp.textContent = '…';
  resp.className   = 'ai-response thinking';
  resp.classList.remove('hidden');
}

function showAIMsg(msg: string, isError: boolean) {
  const resp = document.getElementById('ai-response') as HTMLElement;
  resp.textContent = msg;
  resp.className   = `ai-response ${isError ? 'error' : ''}`;
  resp.classList.remove('hidden');
}

function showAIActions() {
  (document.getElementById('ai-actions') as HTMLElement).classList.remove('hidden');
}

function clearAIActions() {
  (document.getElementById('ai-actions') as HTMLElement).classList.add('hidden');
  pendingAIResp = null;
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

  // Focus input
  const focusInput = document.getElementById('focus-input') as HTMLInputElement;
  focusInput.addEventListener('input', () =>
    localStorage.setItem('styl_focus_text', focusInput.value)
  );

  // AI bar
  const aiInput  = document.getElementById('ai-input') as HTMLInputElement;
  const aiSend   = document.getElementById('ai-send') as HTMLButtonElement;
  const aiImgIn  = document.getElementById('ai-img') as HTMLInputElement;
  const aiImgBtn = document.getElementById('ai-img-btn') as HTMLButtonElement;

  const dispatchAI = () => {
    const prompt = aiInput.value.trim();
    if (!prompt) return;
    clearAIActions();
    (document.getElementById('ai-response') as HTMLElement).classList.add('hidden');
    send({ type: 'aiCommand', prompt });
    aiInput.value = '';
    pendingPrompt = prompt;
  };

  aiSend.addEventListener('click', dispatchAI);
  aiInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); dispatchAI(); }
  });
  aiImgBtn.addEventListener('click', () => aiImgIn.click());
  aiImgIn.addEventListener('change', async () => {
    const file = aiImgIn.files?.[0];
    if (!file) return;
    aiImgIn.value = '';
    const prompt = aiInput.value.trim() || 'Extract tasks from this screenshot';
    const imageData = await fileToBase64(file);
    clearAIActions();
    showAIThinking();
    send({ type: 'aiCommand', prompt, imageData });
    aiInput.value = '';
    pendingPrompt = prompt;
  });

  // AI approve / reject
  document.getElementById('ai-approve-btn')!.addEventListener('click', () => {
    if (!pendingAIResp) return;
    send({ type: 'aiApprove', response: pendingAIResp, prompt: pendingPrompt });
    hideDiff(); clearAIActions();
  });
  document.getElementById('ai-reject-btn')!.addEventListener('click', () => {
    send({ type: 'aiReject' });
    hideDiff(); clearAIActions();
  });
  document.getElementById('diff-approve-btn')!.addEventListener('click', () => {
    if (!pendingAIResp) return;
    send({ type: 'aiApprove', response: pendingAIResp, prompt: pendingPrompt });
    hideDiff(); clearAIActions();
  });
  document.getElementById('diff-reject-btn')!.addEventListener('click', () => {
    send({ type: 'aiReject' });
    hideDiff(); clearAIActions();
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
