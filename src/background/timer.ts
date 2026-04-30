import type { TimerMode, TimerState } from '../shared/types';

export const ALARM_COMPLETE = 'styl-timer-complete';
export const ALARM_KEEPALIVE = 'styl-keepalive';

export function defaultTimerState(): TimerState {
  return {
    mode:                'focus',
    isRunning:           false,
    startTime:           null,
    pausedTimeRemaining: 25 * 60,
    sessionTotal:        25 * 60,
    focusDuration:       25 * 60,
    breakDuration:       5  * 60,
    longBreakDuration:   15 * 60,
    sessionsCompleted:   0,
  };
}

/** Returns live remaining seconds, accounting for elapsed time since startTime. */
export function getTimeRemaining(t: TimerState): number {
  if (!t.isRunning || t.startTime === null) {
    return Math.max(0, t.pausedTimeRemaining);
  }
  const elapsed = Math.floor((Date.now() - t.startTime) / 1000);
  return Math.max(0, t.pausedTimeRemaining - elapsed);
}

export function durationFor(t: TimerState, mode: TimerMode): number {
  switch (mode) {
    case 'focus':     return t.focusDuration;
    case 'break':     return t.breakDuration;
    case 'longBreak': return t.longBreakDuration;
  }
}

export function startTimer(t: TimerState): TimerState {
  if (t.isRunning || t.pausedTimeRemaining <= 0) return t;
  browser.alarms.create(ALARM_COMPLETE, {
    delayInMinutes: t.pausedTimeRemaining / 60,
  });
  return { ...t, isRunning: true, startTime: Date.now() };
}

export function pauseTimer(t: TimerState): TimerState {
  if (!t.isRunning) return t;
  browser.alarms.clear(ALARM_COMPLETE);
  return {
    ...t,
    isRunning:           false,
    startTime:           null,
    pausedTimeRemaining: getTimeRemaining(t),
  };
}

export function resetTimer(t: TimerState): TimerState {
  browser.alarms.clear(ALARM_COMPLETE);
  const duration = durationFor(t, t.mode);
  return {
    ...t,
    isRunning:           false,
    startTime:           null,
    pausedTimeRemaining: duration,
    sessionTotal:        duration,
  };
}

export function skipTimer(t: TimerState): TimerState {
  browser.alarms.clear(ALARM_COMPLETE);
  let { mode, sessionsCompleted } = t;
  if (mode === 'focus') {
    sessionsCompleted++;
    mode = sessionsCompleted % 4 === 0 ? 'longBreak' : 'break';
  } else {
    mode = 'focus';
  }
  const duration = durationFor({ ...t, mode }, mode);
  return {
    ...t, mode, sessionsCompleted,
    isRunning: false, startTime: null,
    pausedTimeRemaining: duration, sessionTotal: duration,
  };
}

export function setTimerMode(t: TimerState, mode: TimerMode): TimerState {
  browser.alarms.clear(ALARM_COMPLETE);
  const duration = durationFor({ ...t, mode }, mode);
  return {
    ...t, mode,
    isRunning: false, startTime: null,
    pausedTimeRemaining: duration, sessionTotal: duration,
  };
}

export function addMinute(t: TimerState): TimerState {
  const newRemaining = getTimeRemaining(t) + 60;
  if (t.isRunning) {
    browser.alarms.clear(ALARM_COMPLETE);
    browser.alarms.create(ALARM_COMPLETE, { delayInMinutes: newRemaining / 60 });
  }
  return {
    ...t,
    pausedTimeRemaining: t.isRunning ? t.pausedTimeRemaining + 60 : newRemaining,
    sessionTotal: t.sessionTotal + 60,
    startTime: t.isRunning ? t.startTime : null,
  };
}

export function onTimerComplete(t: TimerState): { state: TimerState; prevMode: TimerMode } {
  const prevMode = t.mode;
  let { mode, sessionsCompleted } = t;
  if (mode === 'focus') {
    sessionsCompleted++;
    mode = sessionsCompleted % 4 === 0 ? 'longBreak' : 'break';
  } else {
    mode = 'focus';
  }
  const duration = durationFor({ ...t, mode }, mode);
  return {
    prevMode,
    state: {
      ...t, mode, sessionsCompleted,
      isRunning: false, startTime: null,
      pausedTimeRemaining: duration, sessionTotal: duration,
    },
  };
}
