// Styl — blocked page

const params = new URLSearchParams(window.location.search);
const site   = params.get('site') || 'This site';

document.getElementById('site-name').textContent = site;

function fmt(secs) {
  const s = Math.max(0, Math.floor(secs));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

function refresh() {
  browser.runtime.sendMessage({ type: 'getTimerState' })
    .then((resp) => {
      if (!resp || typeof resp.timeRemaining !== 'number' || resp.timeRemaining <= 0) return;
      document.getElementById('timer-val').textContent = fmt(resp.timeRemaining);
      document.getElementById('timer-row').style.display = 'flex';
    })
    .catch(() => {});
}

refresh();
setInterval(refresh, 1000);

document.getElementById('back-btn').addEventListener('click', () => {
  history.length > 1 ? history.go(-2) : window.close();
});
