// Moments new tab controller
// Renders the clock, handles timer display, and connects to the background.

const RING_CIRCUMFERENCE = 2 * Math.PI * 68; // r=68 ≈ 427.26

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
  "The present moment is the only moment available to us.",
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

let port  = null;
let state = null;

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
    h >= 5  && h < 12 ? 'Good morning' :
    h >= 12 && h < 17 ? 'Good afternoon' :
    h >= 17 && h < 21 ? 'Good evening' :
                        'Good night';
  document.getElementById('greeting').textContent = greeting;

  // Background class
  const cls =
    h >= 5  && h < 12 ? 'morning'   :
    h >= 12 && h < 17 ? 'afternoon' :
    h >= 17 && h < 21 ? 'evening'   :
                        'night';

  if (!document.body.classList.contains(cls)) {
    document.body.className = cls;
  }
}

// Align tick to the next full second boundary
function startClock() {
  updateClock();
  const ms = 1000 - (Date.now() % 1000);
  setTimeout(() => {
    updateClock();
    setInterval(updateClock, 1000);
  }, ms);
}

// ── Connection ────────────────────────────────────────────────────────────────

function connect() {
  port = browser.runtime.connect({ name: 'newtab' });

  port.onMessage.addListener((msg) => {
    if (msg.type !== 'stateUpdate') return;
    state = msg.state;
    renderTimer();
    if (msg.event === 'timerComplete') {
      playChime();
    }
  });

  port.onDisconnect.addListener(() => {
    setTimeout(connect, 300);
  });
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

  // Mode tabs
  document.querySelectorAll('.mode-tab').forEach((tab) => {
    tab.classList.toggle('active', tab.dataset.mode === state.mode);
  });

  // Countdown
  document.getElementById('timer-display').textContent = fmt(state.timeRemaining);

  // Progress ring
  const total    = totalFor(state.mode);
  const progress = state.timeRemaining / total;
  const offset   = (1 - progress) * RING_CIRCUMFERENCE;
  document.getElementById('progress-ring').style.strokeDashoffset = offset;

  // Start/Pause
  document.getElementById('start-pause-btn').textContent =
    state.isRunning ? 'Pause' : 'Start';

  // Session dots
  const dots    = document.getElementById('sessions-dots');
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

// ── Event listeners ───────────────────────────────────────────────────────────

document.querySelectorAll('.mode-tab').forEach((tab) => {
  tab.addEventListener('click', () => {
    port.postMessage({ type: 'setMode', mode: tab.dataset.mode });
  });
});

document.getElementById('start-pause-btn').addEventListener('click', () => {
  if (!state) return;
  port.postMessage({ type: state.isRunning ? 'pause' : 'start' });
});

document.getElementById('reset-btn').addEventListener('click', () => {
  port.postMessage({ type: 'reset' });
});

document.getElementById('skip-btn').addEventListener('click', () => {
  port.postMessage({ type: 'skip' });
});

// ── Daily focus (persisted in localStorage) ───────────────────────────────────

const focusInput = document.getElementById('focus-input');

function loadDailyFocus() {
  const today    = new Date().toDateString();
  const saved    = localStorage.getItem('moments_focus_date');
  const savedVal = localStorage.getItem('moments_focus_text');

  if (saved === today && savedVal) {
    focusInput.value = savedVal;
  } else {
    localStorage.removeItem('moments_focus_text');
    localStorage.setItem('moments_focus_date', today);
  }
}

focusInput.addEventListener('input', () => {
  localStorage.setItem('moments_focus_text', focusInput.value);
});

// ── Quote ─────────────────────────────────────────────────────────────────────

function loadQuote() {
  // Rotate daily
  const dayIndex = Math.floor(Date.now() / 86400000) % QUOTES.length;
  document.getElementById('quote').textContent = `"${QUOTES[dayIndex]}"`;
}

// ── Boot ──────────────────────────────────────────────────────────────────────

startClock();
connect();
loadDailyFocus();
loadQuote();
