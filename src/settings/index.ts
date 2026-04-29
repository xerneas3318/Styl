import type { AppSettings, AIProvider, GitHubConfig } from '../shared/types';
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
  showRedirectUri();
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

  // Google — restore saved Client ID into form so user doesn't have to re-enter
  if (settings.google?.clientId) {
    setVal('google-client-id', settings.google.clientId);
  }
  updateGoogleUI();
}

// ── Google OAuth ──────────────────────────────────────────────────────────────

function showRedirectUri() {
  try {
    const uri = browser.identity.getRedirectURL();
    (document.getElementById('redirect-uri-display') as HTMLElement).textContent = uri;
  } catch {
    (document.getElementById('redirect-uri-display') as HTMLElement).textContent =
      'browser.identity not available';
  }
}

function updateGoogleUI() {
  const connected    = document.getElementById('google-connected')    as HTMLElement;
  const disconnected = document.getElementById('google-disconnected') as HTMLElement;
  const sub          = document.getElementById('google-account-sub')  as HTMLElement;

  if (settings.google?.accessToken) {
    connected.classList.remove('hidden');
    disconnected.classList.add('hidden');
    const services = [
      settings.google.gmailEnabled    ? 'Gmail'    : null,
      settings.google.calendarEnabled ? 'Calendar' : null,
    ].filter(Boolean).join(' + ');
    sub.textContent = `${services || 'No services'} active`;
  } else {
    connected.classList.add('hidden');
    disconnected.classList.remove('hidden');
    updateGoogleButtonState();
  }
}

function updateGoogleButtonState() {
  const btn = document.getElementById('connect-google-btn') as HTMLButtonElement;
  const id  = getVal('google-client-id');
  const sec = getVal('google-client-secret');
  btn.disabled = !(id && sec);
}

async function connectGoogle() {
  const clientId     = getVal('google-client-id');
  const clientSecret = getVal('google-client-secret');

  if (!clientId || !clientSecret) {
    showStatus('Enter your Client ID and Client Secret first.', true);
    return;
  }

  const redirectUri = browser.identity.getRedirectURL();
  const authUrl = 'https://accounts.google.com/o/oauth2/v2/auth?' + new URLSearchParams({
    client_id:     clientId,
    redirect_uri:  redirectUri,
    response_type: 'code',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar',
    ].join(' '),
    access_type: 'offline',
    prompt:      'consent',
  }).toString();

  let redirectUrl: string;
  try {
    redirectUrl = await browser.identity.launchWebAuthFlow({ url: authUrl, interactive: true });
  } catch (e) {
    showStatus(`Sign-in cancelled: ${(e as Error).message}`, true);
    return;
  }

  const code = new URL(redirectUrl).searchParams.get('code');
  if (!code) {
    showStatus('No authorization code returned.', true);
    return;
  }

  showStatus('Connecting…', false);
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code,
        client_id:     clientId,
        client_secret: clientSecret,
        redirect_uri:  redirectUri,
        grant_type:    'authorization_code',
      }).toString(),
    });
    const data = await res.json() as {
      access_token?:  string;
      refresh_token?: string;
      expires_in?:    number;
      error?:         string;
      error_description?: string;
    };

    if (data.error) {
      throw new Error(data.error_description ?? data.error);
    }
    if (!data.access_token) {
      throw new Error('No access token in response');
    }

    settings.google = {
      clientId,
      clientSecret,
      accessToken:     data.access_token,
      refreshToken:    data.refresh_token,
      tokenExpiry:     Date.now() + (data.expires_in ?? 3600) * 1000,
      gmailEnabled:    true,
      calendarEnabled: true,
    };
    await Storage.setSettings(settings);
    notifyBackground();
    updateGoogleUI();
    showStatus('Google connected!', false);
  } catch (e) {
    showStatus(`Token exchange failed: ${(e as Error).message}`, true);
  }
}

function disconnectGoogle() {
  settings.google = null;
  Storage.setSettings(settings).then(() => {
    notifyBackground();
    updateGoogleUI();
    showStatus('Google disconnected.', false);
  });
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
    // Google is managed entirely by the OAuth flow — never overwrite from the save button
    google:            settings.google,
    autoApproveAI:     getCheck('auto-approve'),
    focusDuration:     parseInt(getVal('focus-dur'),      10) * 60 || 25 * 60,
    breakDuration:     parseInt(getVal('break-dur'),      10) * 60 || 5  * 60,
    longBreakDuration: parseInt(getVal('long-break-dur'), 10) * 60 || 15 * 60,
  };
}

async function save() {
  settings = collectSettings();
  await Storage.setSettings(settings);
  notifyBackground();
  showStatus('Saved.', false);
}

// ── Notify background ─────────────────────────────────────────────────────────

function notifyBackground() {
  try {
    const port = browser.runtime.connect({ name: 'settings' });
    port.postMessage({ type: 'settingsUpdated', settings });
    port.disconnect();
  } catch { /* background may not be listening; that's OK */ }
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

// ── Snapshot history ──────────────────────────────────────────────────────────

async function loadSnapshots() {
  const snaps = await Storage.getSnapshots();
  const list  = document.getElementById('snapshot-list') as HTMLElement;
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
      if (!confirm(`Revert to ${new Date(snap.timestamp).toLocaleString()}?`)) return;
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

function getVal(id: string) { return (document.getElementById(id) as HTMLInputElement).value.trim(); }
function setVal(id: string, v: string) { (document.getElementById(id) as HTMLInputElement).value = v; }
function getCheck(id: string) { return (document.getElementById(id) as HTMLInputElement).checked; }
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
document.getElementById('copy-redirect-uri')!.addEventListener('click', () => {
  const uri = (document.getElementById('redirect-uri-display') as HTMLElement).textContent ?? '';
  navigator.clipboard.writeText(uri).then(() => showStatus('Copied!', false));
});
document.getElementById('ai-provider')!.addEventListener('change', updateModelPlaceholder);
document.getElementById('google-client-id')!.addEventListener('input', updateGoogleButtonState);
document.getElementById('google-client-secret')!.addEventListener('input', updateGoogleButtonState);

initTabs();
init();
