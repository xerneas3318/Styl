import type { AppState, TimerMode } from '../shared/types';
import { fmt } from '../shared/utils';
import { applyTheme } from '../shared/theme';

declare function playChime(): void;

const RING_C = 2 * Math.PI * 68;

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

let port:      browser.runtime.Port | null = null;
let state:     AppState | null             = null;
let isEditing  = false;

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

function connect() {
  port = browser.runtime.connect({ name: 'newtab' });
  port.onMessage.addListener((msg: Record<string, unknown>) => {
    if (msg.type === 'stateUpdate') {
      state = msg.state as AppState;
      renderTimer();
      renderAddMinBtn();
      syncTimerTick();
      if ((msg as { event?: string }).event === 'timerComplete') playChime();
    }
  });
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 400); });
}

function send(msg: unknown) { port?.postMessage(msg); }

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

function renderTimer() {
  if (!state) return;
  const t = state.timer;
  document.querySelectorAll('.mode-tab').forEach((el) => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.mode === t.mode);
  });
  if (!isEditing) {
    (document.getElementById('time-text') as HTMLElement).textContent = fmt(liveRemaining());
  }
  const progress = t.sessionTotal > 0 ? liveRemaining() / t.sessionTotal : 1;
  const offset   = (1 - Math.min(1, Math.max(0, progress))) * RING_C;
  const ring = document.getElementById('progress-ring') as SVGCircleElement;
  ring.style.strokeDashoffset = String(offset);
  ring.className.baseVal = 'ring-fg' +
    (t.mode === 'break' ? ' break-mode' : t.mode === 'longBreak' ? ' long-mode' : '');
  (document.getElementById('start-pause-btn') as HTMLElement).textContent =
    t.isRunning ? 'Pause' : 'Start';
  const dots  = document.getElementById('sessions-dots') as HTMLElement;
  dots.innerHTML = '';
  const pos = t.sessionsCompleted % 4;
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
  input.focus(); input.select();
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
    type: 'timerUpdateSettings',
    focusDuration:     mode === 'focus'     ? secs : state?.timer.focusDuration,
    breakDuration:     mode === 'break'     ? secs : state?.timer.breakDuration,
    longBreakDuration: mode === 'longBreak' ? secs : state?.timer.longBreakDuration,
  });
}

function buildPresets(mode: TimerMode, current: number) {
  const PRESETS: Record<TimerMode, number[]> = {
    focus: [15, 20, 25, 30, 45, 60, 90],
    break: [5, 10, 15],
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

function loadQuote() {
  const idx = Math.floor(Date.now() / 86_400_000) % QUOTES.length;
  (document.getElementById('quote') as HTMLElement).textContent = `"${QUOTES[idx]}"`;
}

function loadDailyFocus() {
  const today    = new Date().toDateString();
  const savedDay = localStorage.getItem('styl_focus_date');
  const savedVal = localStorage.getItem('styl_focus_text');
  const input    = document.getElementById('focus-input') as HTMLInputElement;
  if (savedDay === today && savedVal) input.value = savedVal;
  else { localStorage.removeItem('styl_focus_text'); localStorage.setItem('styl_focus_date', today); }
}

const DB_NAME = 'styl'; const DB_STORE = 'wallpaper';
let _db: IDBDatabase | null = null; let _wpUrl: string | null = null;

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
    tx.oncomplete = () => res(); tx.onerror = () => rej(tx.error);
  });
}
async function wpLoad(): Promise<Blob | null> {
  const db = await openDB();
  return new Promise((res) => {
    const tx = db.transaction(DB_STORE, 'readonly');
    const req = tx.objectStore(DB_STORE).get('img');
    req.onsuccess = () => res(req.result as Blob | null); req.onerror = () => res(null);
  });
}
async function wpClear() {
  const db = await openDB();
  return new Promise<void>((res) => {
    const tx = db.transaction(DB_STORE, 'readwrite');
    tx.objectStore(DB_STORE).delete('img');
    tx.oncomplete = () => res(); tx.onerror = () => res();
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

function wireEvents() {
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
  document.getElementById('reset-btn')!.addEventListener('click',  () => send({ type: 'timerReset' }));
  document.getElementById('skip-btn')!.addEventListener('click',   () => send({ type: 'timerSkip' }));
  document.getElementById('add-min-btn')!.addEventListener('click',() => send({ type: 'timerAddMinute' }));

  const focusInput = document.getElementById('focus-input') as HTMLInputElement;
  focusInput.addEventListener('input', () =>
    localStorage.setItem('styl_focus_text', focusInput.value)
  );

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

wireEvents();
startClock();
connect();
loadDailyFocus();
loadQuote();
initWallpaper();
applyTheme();
