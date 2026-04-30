import type { AppState, TimerMode, BlockState, BlockGate } from '../shared/types';
import { fmt } from '../shared/utils';

declare function playChime(): void;

const RING_C = 2 * Math.PI * 52; // r=52

const BLOCK_PRESETS: Record<string, string[]> = {
  social: ['instagram.com','facebook.com','twitter.com','x.com','tiktok.com',
           'reddit.com','snapchat.com','pinterest.com','threads.net','linkedin.com','tumblr.com'],
  video:  ['youtube.com','netflix.com','twitch.tv','hulu.com','disneyplus.com','primevideo.com','vimeo.com'],
  news:   ['cnn.com','bbc.com','nytimes.com','buzzfeed.com','theguardian.com','huffpost.com','dailymail.co.uk'],
};

const DURATION_PRESETS: Record<string, number[]> = {
  focus:     [15, 20, 25, 30, 45, 60, 90],
  break:     [5, 10, 15],
  longBreak: [10, 15, 20, 25, 30],
};

let port:       browser.runtime.Port | null = null;
let state:      AppState | null             = null;
let blockState: BlockState = {
  enabled: true, alwaysSites: [], focusSites: [], gate: 'none', bypassPassword: '',
};
let isEditing = false;

// ── Connection ────────────────────────────────────────────────────────────────

function connect() {
  port = browser.runtime.connect({ name: 'popup' });
  port.onMessage.addListener((msg: Record<string, unknown>) => {
    switch (msg.type) {
      case 'stateUpdate':
        state      = msg.state as AppState;
        blockState = (msg.state as AppState).blockState ?? blockState;
        render();
        renderBlockPanel();
        updateShield();
        if ((msg as { event?: string }).event === 'timerComplete') playChime();
        break;
      case 'blockStateUpdate':
        blockState = msg.blockState as BlockState;
        renderBlockPanel();
        updateShield();
        break;
    }
  });
  port.onDisconnect.addListener(() => { port = null; setTimeout(connect, 400); });
}

function send(msg: unknown) { port?.postMessage(msg); }

// ── Timer rendering ───────────────────────────────────────────────────────────

function render() {
  if (!state) return;
  const t = state.timer;

  document.querySelectorAll('.mode-tab').forEach((el) =>
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.mode === t.mode)
  );

  if (!isEditing) {
    (document.getElementById('time-text') as HTMLElement).textContent = fmt(t.pausedTimeRemaining);
  }

  const progress = t.sessionTotal > 0 ? t.pausedTimeRemaining / t.sessionTotal : 1;
  const offset   = (1 - Math.min(1, Math.max(0, progress))) * RING_C;
  const ring     = document.getElementById('progress-ring') as SVGCircleElement;
  ring.style.strokeDashoffset = String(offset);
  ring.className.baseVal = 'ring-fg' +
    (t.mode === 'break' ? ' break-mode' : t.mode === 'longBreak' ? ' long-mode' : '');

  (document.getElementById('start-pause-btn') as HTMLElement).textContent =
    t.isRunning ? 'Pause' : 'Start';

  (document.getElementById('add-min-btn') as HTMLElement).classList.toggle('hidden', !t.isRunning);

  const dots = document.getElementById('sessions-dots') as HTMLElement;
  dots.innerHTML = '';
  const pos = t.sessionsCompleted % 4;
  for (let i = 0; i < 4; i++) {
    const d = document.createElement('div');
    d.className = 'session-dot' + (i < pos ? ' filled' : '');
    dots.appendChild(d);
  }
  (document.getElementById('sessions-label') as HTMLElement).textContent =
    `${t.sessionsCompleted} session${t.sessionsCompleted !== 1 ? 's' : ''} completed`;
}

// ── Edit mode ─────────────────────────────────────────────────────────────────

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

  buildDurationPresets(mode, minutes);
  (document.getElementById('preset-bar') as HTMLElement).classList.remove('hidden');
}

function exitEditMode(save = true) {
  if (!isEditing) return;
  isEditing = false;
  if (save) {
    const raw = parseInt((document.getElementById('time-edit') as HTMLInputElement).value, 10);
    const min = isNaN(raw) ? null : Math.min(Math.max(raw, 1), 180);
    if (min) {
      const secs = min * 60;
      const mode = state?.timer.mode ?? 'focus';
      send({
        type: 'timerUpdateSettings',
        focusDuration:     mode === 'focus'     ? secs : state?.timer.focusDuration,
        breakDuration:     mode === 'break'     ? secs : state?.timer.breakDuration,
        longBreakDuration: mode === 'longBreak' ? secs : state?.timer.longBreakDuration,
      });
    }
  }
  (document.getElementById('time-text')   as HTMLElement).classList.remove('hidden');
  (document.getElementById('time-editor') as HTMLElement).classList.add('hidden');
  (document.getElementById('preset-bar') as HTMLElement).classList.add('hidden');
}

function buildDurationPresets(mode: TimerMode, current: number) {
  const bar = document.getElementById('preset-bar') as HTMLElement;
  bar.innerHTML = '';
  (DURATION_PRESETS[mode] ?? DURATION_PRESETS.focus).forEach((val) => {
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

// ── Block panel ───────────────────────────────────────────────────────────────

function updateShield() {
  const hasAlways = blockState.enabled && blockState.alwaysSites.length > 0;
  const hasFocus  = blockState.enabled && blockState.focusSites.length > 0;
  const active    = hasAlways || hasFocus;
  document.getElementById('shield-btn')!.classList.toggle('active',    active);
  document.getElementById('shield-btn')!.classList.toggle('always-on', hasAlways);
}

function renderSiteList(listId: string, sites: string[], onRemove: (site: string) => void) {
  const list = document.getElementById(listId) as HTMLElement;
  list.innerHTML = '';
  if (!sites.length) {
    const empty = document.createElement('div');
    empty.className = 'bp-empty';
    empty.textContent = 'No sites.';
    list.appendChild(empty);
    return;
  }
  [...sites].sort().forEach((site) => {
    const row = document.createElement('div');
    row.className = 'bp-site-row';
    const dom = document.createElement('span');
    dom.className = 'bp-site-domain';
    dom.textContent = site;
    const rm = document.createElement('button');
    rm.className = 'bp-site-remove';
    rm.textContent = '×';
    rm.addEventListener('click', () => onRemove(site));
    row.append(dom, rm);
    list.appendChild(row);
  });
}

function renderBlockPanel() {
  (document.getElementById('block-enabled') as HTMLInputElement).checked = blockState.enabled;

  // Gate chips
  document.querySelectorAll('.bp-gate-chip').forEach((el) =>
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.gate === blockState.gate)
  );
  (document.getElementById('bp-pw-row') as HTMLElement).classList.toggle('hidden', blockState.gate !== 'password');

  // Preset states for both lists
  document.querySelectorAll('.bp-preset').forEach((el) => {
    const key    = (el as HTMLElement).dataset.preset!;
    const isList = (el as HTMLElement).dataset.list as 'always' | 'focus';
    const preset = BLOCK_PRESETS[key];
    if (!preset) return;
    const sites = isList === 'always' ? blockState.alwaysSites : blockState.focusSites;
    const n = preset.filter((s) => sites.includes(s)).length;
    (el as HTMLElement).classList.toggle('all-on',  n === preset.length);
    (el as HTMLElement).classList.toggle('some-on', n > 0 && n < preset.length);
  });

  // Always block list
  renderSiteList('bp-always-list', blockState.alwaysSites, (site) =>
    send({ type: 'setAlwaysSites', sites: blockState.alwaysSites.filter((s) => s !== site) })
  );

  // Focus block list
  renderSiteList('bp-focus-list', blockState.focusSites, (site) =>
    send({ type: 'setFocusSites', sites: blockState.focusSites.filter((s) => s !== site) })
  );
}

function togglePreset(key: string, list: 'always' | 'focus') {
  const preset = BLOCK_PRESETS[key];
  if (!preset) return;
  const current = list === 'always' ? blockState.alwaysSites : blockState.focusSites;
  const allOn   = preset.every((s) => current.includes(s));
  let next = [...current];
  if (allOn) next = next.filter((s) => !preset.includes(s));
  else preset.forEach((s) => { if (!next.includes(s)) next.push(s); });
  send({ type: list === 'always' ? 'setAlwaysSites' : 'setFocusSites', sites: next });
}

function addSite(raw: string, list: 'always' | 'focus'): boolean {
  const domain = raw.trim().toLowerCase()
    .replace(/^https?:\/\//, '').replace(/^www\./, '').split('/')[0].split('?')[0];
  if (!domain) return false;
  const current = list === 'always' ? blockState.alwaysSites : blockState.focusSites;
  if (current.includes(domain)) return false;
  send({ type: list === 'always' ? 'setAlwaysSites' : 'setFocusSites', sites: [...current, domain] });
  return true;
}

// ── Event wiring ──────────────────────────────────────────────────────────────

function wire() {
  // Shield / back
  document.getElementById('shield-btn')!.addEventListener('click', () => {
    document.getElementById('timer-view')!.classList.add('hidden');
    document.getElementById('block-panel')!.classList.remove('hidden');
  });
  document.getElementById('block-back-btn')!.addEventListener('click', () => {
    document.getElementById('block-panel')!.classList.add('hidden');
    document.getElementById('timer-view')!.classList.remove('hidden');
  });

  // Timer controls
  document.getElementById('time-text')!.addEventListener('click', enterEditMode);
  (document.getElementById('time-edit') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter')  { e.preventDefault(); exitEditMode(true); }
    if (e.key === 'Escape') exitEditMode(false);
  });
  (document.getElementById('time-edit') as HTMLInputElement).addEventListener('blur', () =>
    setTimeout(() => { if (isEditing) exitEditMode(true); }, 150)
  );
  document.querySelectorAll('.mode-tab').forEach((el) =>
    el.addEventListener('click', () =>
      send({ type: 'timerSetMode', mode: (el as HTMLElement).dataset.mode as TimerMode })
    )
  );
  document.getElementById('start-pause-btn')!.addEventListener('click', () => {
    if (!state) return;
    send({ type: state.timer.isRunning ? 'timerPause' : 'timerStart' });
  });
  document.getElementById('reset-btn')!.addEventListener('click', () => send({ type: 'timerReset' }));
  document.getElementById('skip-btn')!.addEventListener('click',  () => send({ type: 'timerSkip' }));
  document.getElementById('add-min-btn')!.addEventListener('click', () => send({ type: 'timerAddMinute' }));

  // Block enabled toggle
  (document.getElementById('block-enabled') as HTMLInputElement).addEventListener('change', (e) =>
    send({ type: 'setBlockEnabled', enabled: (e.target as HTMLInputElement).checked })
  );

  // Gate chips
  document.querySelectorAll('.bp-gate-chip').forEach((el) =>
    el.addEventListener('click', () =>
      send({ type: 'setBlockGate', gate: (el as HTMLElement).dataset.gate as BlockGate })
    )
  );

  // Password save
  document.getElementById('bp-pw-save')!.addEventListener('click', () => {
    const inp = document.getElementById('bp-pw-input') as HTMLInputElement;
    const pw  = inp.value.trim();
    if (!pw) return;
    send({ type: 'setBlockGate', gate: 'password', password: pw });
    inp.value = '';
    const saved = document.getElementById('bp-pw-saved') as HTMLElement;
    saved.classList.remove('hidden');
    setTimeout(() => saved.classList.add('hidden'), 2000);
  });
  (document.getElementById('bp-pw-input') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); document.getElementById('bp-pw-save')!.click(); }
  });

  // Presets (both lists)
  document.querySelectorAll('.bp-preset').forEach((el) =>
    el.addEventListener('click', () => {
      const list   = (el as HTMLElement).dataset.list   as 'always' | 'focus';
      const preset = (el as HTMLElement).dataset.preset as string;
      togglePreset(preset, list);
    })
  );

  // Add site — always
  document.getElementById('bp-always-add')!.addEventListener('click', () => {
    const inp = document.getElementById('bp-always-input') as HTMLInputElement;
    if (addSite(inp.value, 'always')) inp.value = '';
  });
  (document.getElementById('bp-always-input') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inp = e.target as HTMLInputElement;
    if (addSite(inp.value, 'always')) inp.value = '';
  });

  // Add site — focus
  document.getElementById('bp-focus-add')!.addEventListener('click', () => {
    const inp = document.getElementById('bp-focus-input') as HTMLInputElement;
    if (addSite(inp.value, 'focus')) inp.value = '';
  });
  (document.getElementById('bp-focus-input') as HTMLInputElement).addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const inp = e.target as HTMLInputElement;
    if (addSite(inp.value, 'focus')) inp.value = '';
  });

  // Settings link
  document.getElementById('settings-link')?.addEventListener('click', () =>
    browser.tabs.create({ url: browser.runtime.getURL('settings/settings.html') })
  );
}

wire();
connect();
