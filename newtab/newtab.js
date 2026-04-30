// Styl new tab controller

const RING_CIRCUMFERENCE = 2 * Math.PI * 68; // r=68 ≈ 427.26

const PRESETS = {
  focus:     [15, 20, 25, 30, 45, 60, 90],
  break:     [5, 10, 15],
  longBreak: [10, 15, 20, 25, 30],
};

const QUOTES = [
  "The secret of getting ahead is getting started.",
  "Focus on being productive instead of busy.",
  "Do something today that your future self will thank you for.",
  "Small steps every day lead to big results.",
  "The only way to do great work is to love what you do.",
  "You don't have to see the whole staircase, just take the first step.",
  "Energy flows where attention goes.",
  "Discipline is choosing between what you want now and what you want most.",
  "Work hard in silence. Let your results make the noise.",
  "It always seems impossible until it's done.",
  "Your focus determines your reality.",
  "Progress, not perfection.",
  "Start where you are. Use what you have. Do what you can.",
  "The present is the only time you truly have.",
  "One task at a time. Done well.",
  "What you do today can improve all your tomorrows.",
  "Concentrate all your thoughts upon the work at hand.",
  "The quality of your attention determines the quality of your work.",
  "Deep work is the ability to focus without distraction.",
  "Create with intention, rest with purpose.",
];

const DAYS   = ['Sunday','Monday','Tuesday','Wednesday','Thursday','Friday','Saturday'];
const MONTHS = ['January','February','March','April','May','June',
                'July','August','September','October','November','December'];

let port      = null;
let state     = null;
let isEditing = false;

// ── Clock & greeting ──────────────────────────────────────────────────────────

function updateClock() {
  const now  = new Date();
  const h    = now.getHours();
  const m    = now.getMinutes();
  const ampm = h >= 12 ? 'PM' : 'AM';
  const hh   = h % 12 || 12;

  document.getElementById('clock').textContent =
    `${String(hh).padStart(2, '0')}:${String(m).padStart(2, '0')} ${ampm}`;

  document.getElementById('date').textContent =
    `${DAYS[now.getDay()]}, ${MONTHS[now.getMonth()]} ${now.getDate()}`;

  const greeting =
    h >= 5  && h < 12 ? 'Good morning'   :
    h >= 12 && h < 17 ? 'Good afternoon' :
    h >= 17 && h < 21 ? 'Good evening'   :
                        'Good night';
  document.getElementById('greeting').textContent = greeting;

  const cls =
    h >= 5  && h < 12 ? 'morning'   :
    h >= 12 && h < 17 ? 'afternoon' :
    h >= 17 && h < 21 ? 'evening'   :
                        'night';
  if (!document.body.classList.contains(cls)) document.body.className = cls;
}

function startClock() {
  updateClock();
  const ms = 1000 - (Date.now() % 1000);
  setTimeout(() => { updateClock(); setInterval(updateClock, 1000); }, ms);
}

// ── Connection ────────────────────────────────────────────────────────────────

function connect() {
  port = browser.runtime.connect({ name: 'newtab' });
  port.onMessage.addListener((msg) => {
    if (msg.type !== 'stateUpdate') return;
    state = msg.state;
    renderTimer();
    if (msg.event === 'timerComplete') playChime();
  });
  port.onDisconnect.addListener(() => setTimeout(connect, 300));
}

// ── Timer rendering ───────────────────────────────────────────────────────────

function fmt(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function totalFor(mode) {
  if (!state) return 25 * 60;
  switch (mode) {
    case 'focus':     return state.focusDuration;
    case 'break':     return state.breakDuration;
    case 'longBreak': return state.longBreakDuration;
    default:          return state.focusDuration;
  }
}

function renderTimer() {
  if (!state) return;

  document.querySelectorAll('.mode-tab').forEach((t) =>
    t.classList.toggle('active', t.dataset.mode === state.mode));

  if (!isEditing) {
    document.getElementById('time-text').textContent = fmt(state.timeRemaining);
  }

  const total    = state.sessionTotal || totalFor(state.mode);
  const progress = state.timeRemaining / total;
  const offset   = (1 - progress) * RING_CIRCUMFERENCE;
  document.getElementById('progress-ring').style.strokeDashoffset = offset;

  document.getElementById('start-pause-btn').textContent =
    state.isRunning ? 'Pause' : 'Start';

  document.getElementById('add-min-btn').classList.toggle('hidden', !state.isRunning);

  const dots = document.getElementById('sessions-dots');
  dots.innerHTML = '';
  const cyclePos = state.sessionsCompleted % 4;
  for (let i = 0; i < 4; i++) {
    const dot = document.createElement('div');
    dot.className = 's-dot' + (i < cyclePos ? ' filled' : '');
    dots.appendChild(dot);
  }
  document.getElementById('sessions-label').textContent =
    `${state.sessionsCompleted} session${state.sessionsCompleted !== 1 ? 's' : ''} completed`;
}

// ── Edit mode ─────────────────────────────────────────────────────────────────

function enterEditMode() {
  if (isEditing) return;
  isEditing = true;

  if (state?.isRunning) port.postMessage({ type: 'pause' });

  const mode    = state?.mode || 'focus';
  const minutes = Math.round(totalFor(mode) / 60);

  document.getElementById('time-text').classList.add('hidden');
  document.getElementById('time-editor').classList.remove('hidden');
  const input = document.getElementById('time-edit');
  input.value = minutes;
  input.focus();
  input.select();

  buildPresets(mode, minutes);
  document.getElementById('preset-bar').classList.remove('hidden');
}

function exitEditMode(save = true) {
  if (!isEditing) return;
  isEditing = false;

  if (save) {
    const raw     = parseInt(document.getElementById('time-edit').value, 10);
    const minutes = isNaN(raw) ? null : Math.min(Math.max(raw, 1), 180);
    if (minutes) saveMinutes(minutes);
  }

  document.getElementById('time-text').classList.remove('hidden');
  document.getElementById('time-editor').classList.add('hidden');
  document.getElementById('preset-bar').classList.add('hidden');
}

function saveMinutes(minutes) {
  const secs = minutes * 60;
  const mode  = state?.mode || 'focus';
  port.postMessage({
    type:              'updateSettings',
    focusDuration:     mode === 'focus'     ? secs : state.focusDuration,
    breakDuration:     mode === 'break'     ? secs : state.breakDuration,
    longBreakDuration: mode === 'longBreak' ? secs : state.longBreakDuration,
  });
}

function buildPresets(mode, currentMinutes) {
  const bar = document.getElementById('preset-bar');
  bar.innerHTML = '';
  (PRESETS[mode] || PRESETS.focus).forEach((val) => {
    const chip = document.createElement('button');
    chip.className = 'preset-chip' + (val === currentMinutes ? ' active' : '');
    chip.textContent = `${val}m`;
    chip.addEventListener('mousedown', (e) => e.preventDefault());
    chip.addEventListener('click', () => applyPreset(val));
    bar.appendChild(chip);
  });
}

function applyPreset(val) {
  document.getElementById('time-edit').value = val;
  exitEditMode(true);
}

// ── Event wiring ──────────────────────────────────────────────────────────────

document.getElementById('time-text').addEventListener('click', enterEditMode);

document.getElementById('time-edit').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); exitEditMode(true); }
  if (e.key === 'Escape') exitEditMode(false);
});

document.getElementById('time-edit').addEventListener('blur', () => {
  setTimeout(() => { if (isEditing) exitEditMode(true); }, 150);
});

document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () =>
    port.postMessage({ type: 'setMode', mode: tab.dataset.mode }));
});

document.getElementById('start-pause-btn').addEventListener('click', () => {
  if (!state) return;
  port.postMessage({ type: state.isRunning ? 'pause' : 'start' });
});

document.getElementById('reset-btn').addEventListener('click', () =>
  port.postMessage({ type: 'reset' }));

document.getElementById('skip-btn').addEventListener('click', () =>
  port.postMessage({ type: 'skip' }));

document.getElementById('add-min-btn').addEventListener('click', () =>
  port.postMessage({ type: 'addMinute' }));

// ── Daily focus (persisted in localStorage) ───────────────────────────────────

const focusInput = document.getElementById('focus-input');

function loadDailyFocus() {
  const today    = new Date().toDateString();
  const savedDay = localStorage.getItem('styl_focus_date');
  const savedVal = localStorage.getItem('styl_focus_text');
  if (savedDay === today && savedVal) {
    focusInput.value = savedVal;
  } else {
    localStorage.removeItem('styl_focus_text');
    localStorage.setItem('styl_focus_date', today);
  }
}

focusInput.addEventListener('input', () =>
  localStorage.setItem('styl_focus_text', focusInput.value));

// ── Quote ─────────────────────────────────────────────────────────────────────

function loadQuote() {
  const idx = Math.floor(Date.now() / 86400000) % QUOTES.length;
  document.getElementById('quote').textContent = `"${QUOTES[idx]}"`;
}

// ── Wallpaper (IndexedDB — full-resolution Blob, zero quality loss) ───────────

const WP_DB    = 'styl';
const WP_STORE = 'wallpaper';
let   _db      = null;
let   _wpUrl   = null; // active object URL, revoked on replace/remove

function openDB() {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(WP_DB, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(WP_STORE);
    req.onsuccess  = () => { _db = req.result; resolve(_db); };
    req.onerror    = () => reject(req.error);
  });
}

async function wpSave(blob) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(WP_STORE, 'readwrite');
    tx.objectStore(WP_STORE).put(blob, 'img');
    tx.oncomplete = resolve;
    tx.onerror    = () => reject(tx.error);
  });
}

async function wpLoad() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx  = db.transaction(WP_STORE, 'readonly');
    const req = tx.objectStore(WP_STORE).get('img');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror   = () => resolve(null);
  });
}

async function wpClear() {
  const db = await openDB();
  return new Promise((resolve) => {
    const tx = db.transaction(WP_STORE, 'readwrite');
    tx.objectStore(WP_STORE).delete('img');
    tx.oncomplete = resolve;
    tx.onerror    = resolve; // non-fatal
  });
}

function applyBlob(blob) {
  if (_wpUrl) URL.revokeObjectURL(_wpUrl);
  _wpUrl = URL.createObjectURL(blob);
  document.body.style.backgroundImage = `url(${_wpUrl})`;
  document.body.classList.add('has-wallpaper');
  document.getElementById('wallpaper-remove-btn').classList.remove('hidden');
}

function removeWallpaper() {
  if (_wpUrl) { URL.revokeObjectURL(_wpUrl); _wpUrl = null; }
  document.body.style.backgroundImage = '';
  document.body.classList.remove('has-wallpaper');
  document.getElementById('wallpaper-remove-btn').classList.add('hidden');
  wpClear();
}

async function initWallpaper() {
  const blob = await wpLoad();
  if (blob) applyBlob(blob);
}

// File picker
const wallpaperFile = document.getElementById('wallpaper-file');

document.getElementById('wallpaper-upload-btn').addEventListener('click', () =>
  wallpaperFile.click());

wallpaperFile.addEventListener('change', async () => {
  const file = wallpaperFile.files[0];
  if (!file) return;
  wallpaperFile.value = ''; // reset so same file can be re-picked
  await wpSave(file);       // store original Blob — no recompression
  applyBlob(file);
});

document.getElementById('wallpaper-remove-btn').addEventListener('click', removeWallpaper);

// ── Boot ──────────────────────────────────────────────────────────────────────

startClock();
connect();
loadDailyFocus();
loadQuote();
initWallpaper();
