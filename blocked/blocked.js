// Styl — blocked page
// Shows which site was intercepted and the remaining focus time.

const params = new URLSearchParams(window.location.search);
const site   = params.get('site') || 'This site';

document.getElementById('site-name').textContent = site;

// Ask the background for the current timer state (one-shot message)
browser.runtime.sendMessage({ type: 'getTimerState' })
  .then((resp) => {
    if (!resp) return;
    const secs = resp.timeRemaining;
    if (typeof secs !== 'number' || secs <= 0) return;

    const m = Math.floor(secs / 60);
    const s = secs % 60;
    document.getElementById('timer-val').textContent =
      `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    document.getElementById('timer-row').style.display = 'flex';
  })
  .catch(() => {});

document.getElementById('back-btn').addEventListener('click', () => {
  // history.back() returns to the page that triggered the redirect,
  // which would re-block immediately. Navigate to a safe blank page instead.
  history.length > 1 ? history.go(-2) : window.close();
});
