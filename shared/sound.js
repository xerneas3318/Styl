// Styl — chime sound (C-major arpeggio).
// Loaded in the background page AND content pages (popup, newtab).
// The background page (MV2, persistent) has no autoplay restrictions so it
// serves as the reliable trigger; content pages call it on port events.
function playChime() {
  try {
    const AudioContext = window.AudioContext || window.webkitAudioContext;
    if (!AudioContext) return;

    const ctx        = new AudioContext();
    const compressor = ctx.createDynamicsCompressor();
    compressor.threshold.value = -6;
    compressor.knee.value      = 6;
    compressor.ratio.value     = 3;
    compressor.attack.value    = 0.003;
    compressor.release.value   = 0.25;
    compressor.connect(ctx.destination);

    function playNote(freq, startTime, duration = 2.0) {
      // Fundamental — sine for warmth
      const osc1  = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type           = 'sine';
      osc1.frequency.value = freq;
      osc1.connect(gain1);
      gain1.connect(compressor);
      gain1.gain.setValueAtTime(0, startTime);
      gain1.gain.linearRampToValueAtTime(0.55, startTime + 0.015);
      gain1.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
      osc1.start(startTime);
      osc1.stop(startTime + duration);

      // First overtone — triangle for presence
      const osc2  = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type            = 'triangle';
      osc2.frequency.value = freq * 2;
      osc2.connect(gain2);
      gain2.connect(compressor);
      gain2.gain.setValueAtTime(0, startTime);
      gain2.gain.linearRampToValueAtTime(0.2, startTime + 0.015);
      gain2.gain.exponentialRampToValueAtTime(0.001, startTime + duration * 0.6);
      osc2.start(startTime);
      osc2.stop(startTime + duration * 0.6);
    }

    const run = () => {
      const t = ctx.currentTime;
      playNote(523.25, t);         // C5
      playNote(659.25, t + 0.18);  // E5
      playNote(783.99, t + 0.36);  // G5
      playNote(1046.50, t + 0.54); // C6
      setTimeout(() => ctx.close().catch(() => {}), 5000);
    };

    // Resume first in case autoplay policy suspended the context
    if (ctx.state === 'suspended') {
      ctx.resume().then(run).catch(() => {});
    } else {
      run();
    }
  } catch (err) {
    console.warn('Styl: chime failed —', err);
  }
}
