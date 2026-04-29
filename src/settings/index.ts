import type { AppSettings, AIProvider, GitHubConfig, AIConfig, GoogleConfig } from '../shared/types';
import { Storage } from '../shared/storage';
import { GitHubClient } from '../background/github';

// ── Load settings on boot ─────────────────────────────────────────────────────

let settings: AppSettings = {
  github:            null,
  ai:                null,
  google:            null,
  autoApproveAI:     false,
  focusDuration:     25 * 60,
  breakDuration:     5  * 60,
  longBreakDuration: 15 * 60,
};

async function init() {
  const saved = await Storage.getSettings();
  if (saved) settings = saved;
  populateForm();
}

// ── Populate form fields from settings ───────────────────────────────────────

function populateForm() {
  // GitHub
  setVal('gh-owner',  settings.github?.owner  ?? '');
  setVal('gh-repo',   settings.github?.repo   ?? '');
  setVal('gh-token',  settings.github?.token  ?? '');
  setVal('gh-branch', settings.github?.branch ?? 'main');

  // AI
  setVal('ai-provider', settings.ai?.provider ?? 'anthropic');
  setVal('ai-key',      settings.ai?.apiKey   ?? '');
  setVal('ai-model',    settings.ai?.model    ?? '');
  updateModelPlaceholder();

  // Behaviour
  setCheck('auto-approve', settings.autoApproveAI);
  setVal('focus-dur',      String(Math.round((settings.focusDuration    ?? 25 * 60) / 60)));
  setVal('break-dur',      String(Math.round((settings.breakDuration    ?? 5  * 60) / 60)));
  setVal('long-break-dur', String(Math.round((settings.longBreakDuration ?? 15 * 60) / 60)));

  // Google status
  const gStatus = document.getElementById('google-status') as HTMLElement;
  gStatus.textContent = settings.google?.accessToken
    ? `Connected (token expires ${settings.google.tokenExpiry ? new Date(settings.google.tokenExpiry).toLocaleDateString() : 'unknown'})`
    : 'Not connected';
}

// ── Save ──────────────────────────────────────────────────────────────────────

function collectSettings(): AppSettings {
  const provider = getVal('ai-provider') as AIProvider;
  return {
    github: {
      owner:  getVal('gh-owner'),
      repo:   getVal('gh-repo'),
      token:  getVal('gh-token'),
      branch: getVal('gh-branch') || 'main',
    },
    ai: {
      provider,
      apiKey: getVal('ai-key'),
      model:  getVal('ai-model') || defaultModel(provider),
    },
    google:          settings.google ?? null,
    autoApproveAI:   getCheck('auto-approve'),
    focusDuration:   parseInt(getVal('focus-dur'),      10) * 60 || 25 * 60,
    breakDuration:   parseInt(getVal('break-dur'),      10) * 60 || 5  * 60,
    longBreakDuration: parseInt(getVal('long-break-dur'), 10) * 60 || 15 * 60,
  };
}

async function save() {
  settings = collectSettings();
  await Storage.setSettings(settings);

  // Notify background
  try {
    const port = browser.runtime.connect({ name: 'settings' });
    port.postMessage({ type: 'settingsUpdated', settings });
    port.disconnect();
  } catch { /* background may not be listening on this port name, that's OK */ }

  showStatus('Saved.', false);
}

// ── GitHub test ───────────────────────────────────────────────────────────────

async function testGitHub() {
  const cfg: GitHubConfig = {
    owner:  getVal('gh-owner'),
    repo:   getVal('gh-repo'),
    token:  getVal('gh-token'),
    branch: getVal('gh-branch') || 'main',
  };
  if (!cfg.owner || !cfg.repo || !cfg.token) {
    showStatus('Fill in all GitHub fields first.', true); return;
  }
  showStatus('Testing…', false);
  const gh = new GitHubClient(cfg);
  const { ok, error } = await gh.testConnection();
  if (ok) {
    showStatus('GitHub connected!', false);
    await gh.bootstrap();
  } else {
    showStatus(`GitHub error: ${error ?? 'unknown'}`, true);
  }
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

function connectGoogle() {
  // Use browser.identity.launchWebAuthFlow
  const redirectUri = browser.identity.getRedirectURL();
  const params = new URLSearchParams({
    client_id:    getVal('google-client-id') || 'YOUR_CLIENT_ID',
    redirect_uri: redirectUri,
    response_type: 'token',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar',
    ].join(' '),
    include_granted_scopes: 'true',
  });
  const authUrl = `https://accounts.google.com/o/oauth2/v2/auth?${params}`;

  browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true })
    .then((redirectUrl) => {
      if (!redirectUrl) { showStatus('Google auth failed.', true); return; }
      const hash   = new URL(redirectUrl).hash.slice(1);
      const urlp   = new URLSearchParams(hash);
      const token  = urlp.get('access_token');
      const expiry = parseInt(urlp.get('expires_in') ?? '3600', 10) * 1000 + Date.now();
      if (!token) { showStatus('No token received.', true); return; }

      settings.google = {
        accessToken:     token,
        tokenExpiry:     expiry,
        gmailEnabled:    true,
        calendarEnabled: true,
      };
      Storage.setSettings(settings).then(() => {
        populateForm();
        showStatus('Google connected!', false);
      });
    })
    .catch((e) => showStatus(`OAuth error: ${(e as Error).message}`, true));
}

function disconnectGoogle() {
  settings.google = null;
  Storage.setSettings(settings).then(() => {
    populateForm();
    showStatus('Google disconnected.', false);
  });
}

// ── Snapshot history ──────────────────────────────────────────────────────────

async function loadSnapshots() {
  const snaps   = await Storage.getSnapshots();
  const list    = document.getElementById('snapshot-list') as HTMLElement;
  list.innerHTML = '';

  if (!snaps.length) {
    list.innerHTML = '<div class="snap-empty">No snapshots yet.</div>';
    return;
  }

  snaps.slice(0, 20).forEach((snap) => {
    const row = document.createElement('div');
    row.className = 'snap-row';

    const ts = document.createElement('span');
    ts.className   = 'snap-ts';
    ts.textContent = new Date(snap.timestamp).toLocaleString();

    const info = document.createElement('span');
    info.className   = 'snap-info';
    info.textContent = `${snap.tasks.length} task${snap.tasks.length !== 1 ? 's' : ''}`;

    const revert = document.createElement('button');
    revert.className   = 'snap-revert';
    revert.textContent = 'Revert';
    revert.addEventListener('click', () => {
      if (!confirm(`Revert to snapshot from ${new Date(snap.timestamp).toLocaleString()}?`)) return;
      const port = browser.runtime.connect({ name: 'settings' });
      port.postMessage({ type: 'revertToSnapshot', snapshotId: snap.id });
      port.disconnect();
      showStatus('Reverted.', false);
    });

    row.append(ts, info, revert);
    list.appendChild(row);
  });
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function getVal(id: string)  { return (document.getElementById(id) as HTMLInputElement).value.trim(); }
function setVal(id: string, v: string) { (document.getElementById(id) as HTMLInputElement).value = v; }
function getCheck(id: string)  { return (document.getElementById(id) as HTMLInputElement).checked; }
function setCheck(id: string, v: boolean) { (document.getElementById(id) as HTMLInputElement).checked = v; }

function showStatus(msg: string, isError: boolean) {
  const el = document.getElementById('status-msg') as HTMLElement;
  el.textContent = msg;
  el.className   = `status-msg ${isError ? 'error' : 'ok'}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

function defaultModel(provider: AIProvider): string {
  return provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini';
}

function updateModelPlaceholder() {
  const provider = getVal('ai-provider') as AIProvider;
  const input    = document.getElementById('ai-model') as HTMLInputElement;
  input.placeholder = defaultModel(provider);
}

// ── Tab navigation ────────────────────────────────────────────────────────────

function initTabs() {
  document.querySelectorAll('.tab-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = (btn as HTMLElement).dataset.tab!;
      document.querySelectorAll('.tab-btn').forEach((b) => b.classList.remove('active'));
      document.querySelectorAll('.tab-panel').forEach((p) => p.classList.add('hidden'));
      btn.classList.add('active');
      document.getElementById(`tab-${target}`)!.classList.remove('hidden');
      if (target === 'history') loadSnapshots();
    });
  });
}

// ── Wire events ───────────────────────────────────────────────────────────────

document.getElementById('save-btn')!.addEventListener('click', save);
document.getElementById('test-github-btn')!.addEventListener('click', testGitHub);
document.getElementById('connect-google-btn')!.addEventListener('click', connectGoogle);
document.getElementById('disconnect-google-btn')!.addEventListener('click', disconnectGoogle);
document.getElementById('ai-provider')!.addEventListener('change', updateModelPlaceholder);

initTabs();
init();
