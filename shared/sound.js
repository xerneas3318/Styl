// Plays a soft ascending major-chord chime using the Web Audio API.
// Call playChime() from any page that receives a 'timerComplete' event.
function playChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    const ctx = new AudioContext();

    function playNote(frequency, startTime, duration = 1.8) {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();

      osc.connect(gain);
      gain.connect(ctx.destination);

      osc.type = 'sine';
      osc.frequency.value = frequency;

      // Soft attack, natural exponential decay
      gain.gain.setValueAtTime(0, startTime);
      gain.gain.linearRampToValueAtTime(0.18, startTime + 0.03);
      gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);

      osc.start(startTime);
      osc.stop(startTime + duration);
    }

    const t = ctx.currentTime;
    // C major arpeggio: C5 → E5 → G5 → C6
    playNote(523.25, t);            // C5
    playNote(659.25, t + 0.16);     // E5
    playNote(783.99, t + 0.32);     // G5
    playNote(1046.50, t + 0.48);    // C6

    setTimeout(() => ctx.close().catch(() => {}), 4000);
  } catch (err) {
    console.warn('Moments: could not play chime', err);
  }
}
