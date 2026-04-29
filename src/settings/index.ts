import type { AppSettings, AIProvider, GitHubConfig } from '../shared/types';
import { Storage } from '../shared/storage';
import { GitHubClient } from '../background/github';

// ── State ─────────────────────────────────────────────────────────────────────

let settings: AppSettings = {
  github:            null,
  ai:                null,
  google:            null,
  autoApproveAI:     false,
  focusDuration:     25 * 60,
  breakDuration:     5  * 60,
  longBreakDuration: 15 * 60,
};

/** Timer ID for GitHub device-code polling */
let ghPollTimer: ReturnType<typeof setTimeout> | null = null;

async function init() {
  const saved = await Storage.getSettings();
  if (saved) settings = saved;
  populateForm();
  showRedirectUri();
}

// ── Populate form fields from settings ───────────────────────────────────────

function populateForm() {
  // GitHub — if connected, populate connected UI
  if (settings.github?.clientId) {
    setVal('gh-client-id', settings.github.clientId);
  }
  setVal('gh-branch', settings.github?.branch ?? 'main');
  updateGitHubUI();

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

  // Google — restore saved Client ID into form
  if (settings.google?.clientId) setVal('google-client-id', settings.google.clientId);
  updateGoogleUI();
}

// ── GitHub Device Flow ────────────────────────────────────────────────────────

function updateGitHubUI() {
  const connected    = document.getElementById('github-connected')    as HTMLElement;
  const disconnected = document.getElementById('github-disconnected') as HTMLElement;

  if (settings.github?.token && settings.github?.owner) {
    connected.classList.remove('hidden');
    disconnected.classList.add('hidden');
    (document.getElementById('github-account-label') as HTMLElement).textContent =
      `@${settings.github.owner}`;
    (document.getElementById('github-account-sub') as HTMLElement).textContent =
      settings.github.repo ? `/${settings.github.repo}` : 'No repo selected';
    setVal('gh-branch', settings.github.branch || 'main');
    populateRepoSelect(settings.github.owner, settings.github.token);
  } else {
    connected.classList.add('hidden');
    disconnected.classList.remove('hidden');
    updateGitHubButtonState();
  }
}

function updateGitHubButtonState() {
  const btn = document.getElementById('connect-github-btn') as HTMLButtonElement;
  btn.disabled = !getVal('gh-client-id');
}

async function connectGitHub() {
  const clientId = getVal('gh-client-id');
  if (!clientId) {
    showStatus('Enter your GitHub OAuth App Client ID first.', true);
    return;
  }

  // Step 1: Request device & user codes
  showStatus('Requesting device code…', false);
  let codeData: {
    device_code:      string;
    user_code:        string;
    verification_uri: string;
    expires_in:       number;
    interval:         number;
    error?:           string;
  };

  try {
    const res = await fetch('https://github.com/login/device/code', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body:    JSON.stringify({ client_id: clientId, scope: 'repo' }),
    });
    codeData = await res.json();
  } catch (e) {
    showStatus(`Failed to reach GitHub: ${(e as Error).message}`, true);
    return;
  }

  if (codeData.error) {
    showStatus(`GitHub error: ${codeData.error}`, true);
    return;
  }

  // Step 2: Show user code and open github.com/login/device
  (document.getElementById('gh-device-code') as HTMLElement).textContent = codeData.user_code;
  (document.getElementById('gh-device-prompt') as HTMLElement).classList.remove('hidden');
  (document.getElementById('connect-github-btn') as HTMLButtonElement).disabled = true;
  window.open(codeData.verification_uri, '_blank');

  // Step 3: Poll for the token
  const interval  = (codeData.interval ?? 5) * 1000;
  const expiresAt = Date.now() + (codeData.expires_in ?? 900) * 1000;

  const poll = async () => {
    if (Date.now() > expiresAt) {
      showStatus('Code expired — try again.', true);
      resetDevicePrompt();
      return;
    }

    let tokenData: { access_token?: string; error?: string; error_description?: string };
    try {
      const res = await fetch('https://github.com/login/oauth/access_token', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body:    JSON.stringify({
          client_id:   clientId,
          device_code: codeData.device_code,
          grant_type:  'urn:ietf:params:oauth:grant-type:device_code',
        }),
      });
      tokenData = await res.json();
    } catch {
      ghPollTimer = setTimeout(poll, interval);
      return;
    }

    if (tokenData.access_token) {
      resetDevicePrompt();
      await onGitHubToken(clientId, tokenData.access_token);
    } else if (tokenData.error === 'authorization_pending' || tokenData.error === 'slow_down') {
      ghPollTimer = setTimeout(poll, tokenData.error === 'slow_down' ? interval + 5000 : interval);
    } else {
      showStatus(`GitHub auth failed: ${tokenData.error_description ?? tokenData.error}`, true);
      resetDevicePrompt();
    }
  };

  ghPollTimer = setTimeout(poll, interval);
}

function resetDevicePrompt() {
  (document.getElementById('gh-device-prompt')    as HTMLElement).classList.add('hidden');
  (document.getElementById('connect-github-btn') as HTMLButtonElement).disabled = false;
  if (ghPollTimer) { clearTimeout(ghPollTimer); ghPollTimer = null; }
}

async function onGitHubToken(clientId: string, token: string) {
  // Fetch authenticated user's username
  let username = '';
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const u = await res.json() as { login: string };
    username = u.login;
  } catch {
    showStatus('Connected but could not fetch username.', true);
    return;
  }

  settings.github = {
    owner:    username,
    repo:     settings.github?.repo     ?? '',
    branch:   settings.github?.branch   ?? 'main',
    token,
    clientId,
  };
  await Storage.setSettings(settings);
  notifyBackground();
  updateGitHubUI();
  showStatus(`Connected as @${username}!`, false);
}

async function populateRepoSelect(owner: string, token: string) {
  const select = document.getElementById('gh-repo-select') as HTMLSelectElement;
  select.innerHTML = '<option value="">Loading…</option>';

  try {
    const res   = await fetch('https://api.github.com/user/repos?per_page=100&sort=updated', {
      headers: { Authorization: `Bearer ${token}` },
    });
    const repos = await res.json() as Array<{ name: string; private: boolean }>;

    select.innerHTML = '<option value="">— pick a repository —</option>';
    repos.forEach((r) => {
      const opt = document.createElement('option');
      opt.value       = r.name;
      opt.textContent = `${owner}/${r.name}${r.private ? ' 🔒' : ''}`;
      if (r.name === settings.github?.repo) opt.selected = true;
      select.appendChild(opt);
    });
  } catch {
    select.innerHTML = '<option value="">Could not load repos</option>';
  }
}

async function disconnectGitHub() {
  if (ghPollTimer) { clearTimeout(ghPollTimer); ghPollTimer = null; }
  settings.github = null;
  await Storage.setSettings(settings);
  notifyBackground();
  updateGitHubUI();
  showStatus('GitHub disconnected.', false);
}

async function testGitHub() {
  if (!settings.github?.token || !settings.github?.repo) {
    showStatus('Connect GitHub and pick a repo first.', true); return;
  }
  showStatus('Testing…', false);
  const gh = new GitHubClient(settings.github);
  const { ok, error } = await gh.testConnection();
  if (ok) {
    showStatus('GitHub connected! Bootstrapping repo…', false);
    await gh.bootstrap();
    showStatus('GitHub ready.', false);
  } else {
    showStatus(`GitHub error: ${error ?? 'unknown'}`, true);
  }
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
    showStatus('Enter Client ID and Client Secret first.', true); return;
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
    showStatus(`Sign-in cancelled: ${(e as Error).message}`, true); return;
  }

  const code = new URL(redirectUrl).searchParams.get('code');
  if (!code) { showStatus('No authorization code returned.', true); return; }

  showStatus('Connecting…', false);
  try {
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    new URLSearchParams({
        code, client_id: clientId, client_secret: clientSecret,
        redirect_uri: redirectUri, grant_type: 'authorization_code',
      }).toString(),
    });
    const data = await res.json() as {
      access_token?:  string;
      refresh_token?: string;
      expires_in?:    number;
      error?:         string;
      error_description?: string;
    };
    if (data.error) throw new Error(data.error_description ?? data.error);
    if (!data.access_token) throw new Error('No access token in response');

    settings.google = {
      clientId, clientSecret,
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
    // GitHub is managed by the OAuth flow — only sync branch from the form
    github: settings.github
      ? { ...settings.github, branch: getVal('gh-branch') || 'main' }
      : null,
    ai: {
      provider,
      apiKey: getVal('ai-key'),
      model:  getVal('ai-model') || defaultModel(provider),
    },
    // Google is managed by the OAuth flow
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
  setTimeout(() => el.classList.add('hidden'), 5000);
}

function defaultModel(provider: AIProvider): string {
  return provider === 'anthropic' ? 'claude-haiku-4-5-20251001' : 'gpt-4o-mini';
}

function updateModelPlaceholder() {
  const provider = getVal('ai-provider') as AIProvider;
  (document.getElementById('ai-model') as HTMLInputElement).placeholder = defaultModel(provider);
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

// GitHub
document.getElementById('connect-github-btn')!.addEventListener('click', connectGitHub);
document.getElementById('disconnect-github-btn')!.addEventListener('click', disconnectGitHub);
document.getElementById('test-github-btn')!.addEventListener('click', testGitHub);
document.getElementById('gh-client-id')!.addEventListener('input', updateGitHubButtonState);
document.getElementById('copy-device-code')!.addEventListener('click', () => {
  const code = (document.getElementById('gh-device-code') as HTMLElement).textContent ?? '';
  navigator.clipboard.writeText(code).then(() => showStatus('Code copied!', false));
});
document.getElementById('gh-repo-select')!.addEventListener('change', async () => {
  if (!settings.github) return;
  const repo = (document.getElementById('gh-repo-select') as HTMLSelectElement).value;
  settings.github = { ...settings.github, repo };
  await Storage.setSettings(settings);
  notifyBackground();
  (document.getElementById('github-account-sub') as HTMLElement).textContent =
    repo ? `/${repo}` : 'No repo selected';
  if (repo) showStatus(`Repo set to ${settings.github.owner}/${repo}.`, false);
});
document.getElementById('gh-branch')!.addEventListener('change', async () => {
  if (!settings.github) return;
  settings.github = { ...settings.github, branch: getVal('gh-branch') || 'main' };
  await Storage.setSettings(settings);
  notifyBackground();
});

// Google
document.getElementById('connect-google-btn')!.addEventListener('click', connectGoogle);
document.getElementById('disconnect-google-btn')!.addEventListener('click', disconnectGoogle);
document.getElementById('copy-redirect-uri')!.addEventListener('click', () => {
  const uri = (document.getElementById('redirect-uri-display') as HTMLElement).textContent ?? '';
  navigator.clipboard.writeText(uri).then(() => showStatus('Copied!', false));
});
document.getElementById('google-client-id')!.addEventListener('input', updateGoogleButtonState);
document.getElementById('google-client-secret')!.addEventListener('input', updateGoogleButtonState);

// AI + general
document.getElementById('save-btn')!.addEventListener('click', save);
document.getElementById('ai-provider')!.addEventListener('change', updateModelPlaceholder);

initTabs();
init();
