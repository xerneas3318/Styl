// Browser namespace shim: Chrome uses `chrome`, Firefox uses `browser`.
if (typeof browser === 'undefined') { var browser = chrome; } // eslint-disable-line no-var

// Styl — blocked page

const params        = new URLSearchParams(window.location.search);
const site          = params.get('site') || 'This site';
// Firefox webRequest redirects carry the full originating URL in `from`.
// Chrome declarativeNetRequest redirects do not; fall back to the site root.
const fromUrl       = params.get('from') || (site !== 'This site' ? 'https://' + site : '');
const gate          = params.get('gate') || 'none'; // 'none' | 'confirm' | 'password'
const bm            = params.get('bm')   || 'focus'; // 'focus' | 'always'
// annoyingLevel is fetched live from background on each proceed attempt
// so changing the setting takes effect immediately on the already-open blocked page.

document.getElementById('site-name').textContent = site;
document.getElementById('headline').textContent  =
  bm === 'always' ? 'is always blocked.' : 'is blocked during focus.';

function fmt(secs) {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function goBack() {
  history.length > 1 ? history.go(-2) : window.close();
}

// Request a temporary bypass from background, then navigate.
// This prevents the webRequest listener from immediately re-blocking.
function goTo(url) {
  if (!url) { window.close(); return; }
  browser.runtime.sendMessage({ type: 'requestBypass', site })
    .then(() => { window.location.href = url; })
    .catch(() => { window.location.href = url; });
}

// ── Timer countdown — only shown for focus-mode blocks ───────────────────

if (bm === 'focus') {
  function refreshTimer() {
    browser.runtime.sendMessage({ type: 'getTimerState' })
      .then((resp) => {
        if (!resp || typeof resp.timeRemaining !== 'number' || resp.timeRemaining <= 0) return;
        document.getElementById('timer-val').textContent = fmt(resp.timeRemaining);
        document.getElementById('timer-row').style.display = 'flex';
      })
      .catch(() => {});
  }
  refreshTimer();
  setInterval(refreshTimer, 1000);
}

// ── Annoying second gate ──────────────────────────────────────────────────

function randomizeBtn(btn) {
  const margin = 20;
  const bw = btn.offsetWidth  || 140;
  const bh = btn.offsetHeight || 42;
  const x = margin + Math.floor(Math.random() * Math.max(0, window.innerWidth  - bw - margin * 2));
  const y = margin + Math.floor(Math.random() * Math.max(0, window.innerHeight - bh - margin * 2));
  btn.style.left = x + 'px';
  btn.style.top  = y + 'px';
}

function showAnnoyingGate(level) {
  document.getElementById('annoying-gate').classList.remove('hidden');
  const btn = document.getElementById('annoying-proceed');
  btn.classList.remove('hidden');
  // Wait a frame so the button is laid out and offsetWidth/Height are available.
  requestAnimationFrame(() => randomizeBtn(btn));

  if (level === 'high' || level === 'extra-high') {
    // High: jumps every 1s. Extra-high: jumps every 500ms.
    const ms = level === 'extra-high' ? 500 : 1000;
    const interval = setInterval(() => randomizeBtn(btn), ms);
    btn.addEventListener('click', () => { clearInterval(interval); goTo(fromUrl); });
  } else {
    btn.addEventListener('click', () => goTo(fromUrl));
  }

  document.getElementById('back-btn-annoying').addEventListener('click', goBack);
}

// Fetch the live annoying level from background, then either navigate or show the second gate.
// Querying at click-time means changing the setting takes effect on the already-open page.
function proceedWithAnnoyingCheck(hideEl) {
  browser.runtime.sendMessage({ type: 'getBlockState' })
    .then((resp) => {
      const level = (resp && resp.annoyingLevel) || 'off';
      if (level !== 'off') {
        if (hideEl) hideEl.classList.add('hidden');
        showAnnoyingGate(level);
      } else {
        goTo(fromUrl);
      }
    })
    .catch(() => goTo(fromUrl));
}

// ── Gate UI ───────────────────────────────────────────────────────────────

if (gate === 'confirm') {
  document.getElementById('confirm-gate').classList.remove('hidden');
  document.getElementById('visit-btn').addEventListener('click', () => {
    proceedWithAnnoyingCheck(document.getElementById('confirm-gate'));
  });
  document.getElementById('back-btn-confirm').addEventListener('click', goBack);

} else if (gate === 'password') {
  document.getElementById('pw-gate').classList.remove('hidden');

  const pwInput = document.getElementById('pw-input');
  const pwError = document.getElementById('pw-error');

  function tryUnlock() {
    const entered = pwInput.value;
    browser.runtime.sendMessage({ type: 'checkBypassPassword', password: entered })
      .then((resp) => {
        if (resp && resp.allowed) {
          proceedWithAnnoyingCheck(document.getElementById('pw-gate'));
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
  // gate = 'none' — hard block
  document.getElementById('back-btn-hard').classList.remove('hidden');
  document.getElementById('back-btn-hard').addEventListener('click', goBack);
}
