// Styl — blocked page

const params  = new URLSearchParams(window.location.search);
const site    = params.get('site') || 'This site';
const fromUrl = params.get('from') || '';
const gate    = params.get('gate') || 'none'; // 'none' | 'confirm' | 'password'

document.getElementById('site-name').textContent = site;

// Update headline based on whether it's always-blocked or focus-blocked
// (we can tell by presence of timer later, but set default now)
document.getElementById('headline').textContent = 'is blocked.';

function fmt(secs) {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function goBack() {
  history.length > 1 ? history.go(-2) : window.close();
}

function goTo(url) {
  if (url) {
    window.location.href = url;
  } else {
    window.close();
  }
}

// ── Timer countdown (only meaningful when blocking during focus) ──────────

function refreshTimer() {
  browser.runtime.sendMessage({ type: 'getTimerState' })
    .then((resp) => {
      if (!resp || typeof resp.timeRemaining !== 'number' || resp.timeRemaining <= 0) return;
      document.getElementById('timer-val').textContent = fmt(resp.timeRemaining);
      document.getElementById('timer-row').style.display = 'flex';
      document.getElementById('headline').textContent = 'is blocked during focus.';
    })
    .catch(() => {});
}

refreshTimer();
setInterval(refreshTimer, 1000);

// ── Show correct gate UI ──────────────────────────────────────────────────

if (gate === 'confirm') {
  document.getElementById('confirm-gate').classList.remove('hidden');

  document.getElementById('visit-btn').addEventListener('click', () => goTo(fromUrl));
  document.getElementById('back-btn-confirm').addEventListener('click', goBack);

} else if (gate === 'password') {
  document.getElementById('pw-gate').classList.remove('hidden');

  const pwInput   = document.getElementById('pw-input');
  const pwError   = document.getElementById('pw-error');

  function tryUnlock() {
    const entered = pwInput.value;
    browser.runtime.sendMessage({ type: 'checkBypassPassword', password: entered })
      .then((resp) => {
        if (resp && resp.allowed) {
          goTo(fromUrl);
        } else {
          pwError.classList.remove('hidden');
          pwInput.value = '';
          pwInput.focus();
          setTimeout(() => pwError.classList.add('hidden'), 3000);
        }
      })
      .catch(() => {});
  }

  document.getElementById('pw-unlock-btn').addEventListener('click', tryUnlock);
  pwInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); tryUnlock(); }
  });
  document.getElementById('back-btn-pw').addEventListener('click', goBack);

} else {
  // gate = 'none' — hard block, just offer go-back
  document.getElementById('back-btn-hard').classList.remove('hidden');
  document.getElementById('back-btn-hard').addEventListener('click', goBack);
}
