import type { AppSettings, ThemeMode, FontSize } from '../shared/types';
import { Storage } from '../shared/storage';
import { applyTheme, applyThemeFromSettings } from '../shared/theme';

let settings: AppSettings = {
  focusDuration: 25 * 60, breakDuration: 5 * 60, longBreakDuration: 15 * 60,
  theme: 'dark', fontSize: 'medium', apiKey: '',
};

async function init() {
  const saved = await Storage.getSettings();
  if (saved) settings = { ...settings, ...saved };
  populateForm();
  await applyTheme();
}

function populateForm() {
  // Theme chips
  document.querySelectorAll('[data-theme]').forEach((el) => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.theme === (settings.theme ?? 'dark'));
  });
  // Size chips
  document.querySelectorAll('[data-size]').forEach((el) => {
    (el as HTMLElement).classList.toggle('active', (el as HTMLElement).dataset.size === (settings.fontSize ?? 'medium'));
  });
  // Timer
  setVal('focus-dur',      String(Math.round((settings.focusDuration    ?? 25 * 60) / 60)));
  setVal('break-dur',      String(Math.round((settings.breakDuration    ?? 5  * 60) / 60)));
  setVal('long-break-dur', String(Math.round((settings.longBreakDuration ?? 15 * 60) / 60)));
  // API
  setVal('api-key', settings.apiKey ?? '');
}

function collectSettings(): AppSettings {
  return {
    ...settings,
    focusDuration:     parseInt(getVal('focus-dur'),      10) * 60 || 25 * 60,
    breakDuration:     parseInt(getVal('break-dur'),      10) * 60 || 5  * 60,
    longBreakDuration: parseInt(getVal('long-break-dur'), 10) * 60 || 15 * 60,
    apiKey: getVal('api-key'),
  };
}

async function save() {
  settings = collectSettings();
  await Storage.setSettings(settings);
  notifyBackground();
  showStatus('Saved.', false);
}

function notifyBackground() {
  try {
    const port = browser.runtime.connect({ name: 'settings' });
    port.postMessage({ type: 'settingsUpdated', settings });
    port.disconnect();
  } catch { /* ok */ }
}

// UI helpers
function getVal(id: string) { return (document.getElementById(id) as HTMLInputElement).value.trim(); }
function setVal(id: string, v: string) { (document.getElementById(id) as HTMLInputElement).value = v; }

function showStatus(msg: string, isError: boolean) {
  const el = document.getElementById('status-msg') as HTMLElement;
  el.textContent = msg;
  el.className   = `status-msg ${isError ? 'error' : 'ok'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

// Tab navigation
function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = (btn as HTMLElement).dataset.tab!;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${target}`)!.classList.remove('hidden');
    });
  });
}

// Wire events
document.getElementById('save-btn')!.addEventListener('click', save);

// Theme chip clicks — preview immediately
document.querySelectorAll('[data-theme]').forEach((el) =>
  el.addEventListener('click', () => {
    const theme = (el as HTMLElement).dataset.theme as ThemeMode;
    settings = { ...settings, theme };
    document.querySelectorAll('[data-theme]').forEach((e) =>
      (e as HTMLElement).classList.toggle('active', (e as HTMLElement).dataset.theme === theme)
    );
    applyThemeFromSettings(settings);
  })
);

// Size chip clicks — preview immediately
document.querySelectorAll('[data-size]').forEach((el) =>
  el.addEventListener('click', () => {
    const fontSize = (el as HTMLElement).dataset.size as FontSize;
    settings = { ...settings, fontSize };
    document.querySelectorAll('[data-size]').forEach((e) =>
      (e as HTMLElement).classList.toggle('active', (e as HTMLElement).dataset.size === fontSize)
    );
    applyThemeFromSettings(settings);
  })
);

initTabs();
init();
