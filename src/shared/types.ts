export type TimerMode = 'focus' | 'break' | 'longBreak';

export interface TimerState {
  mode:                 TimerMode;
  isRunning:            boolean;
  startTime:            number | null;
  pausedTimeRemaining:  number;
  sessionTotal:         number;
  focusDuration:        number;
  breakDuration:        number;
  longBreakDuration:    number;
  sessionsCompleted:    number;
}

export interface BlockState {
  enabled: boolean;
  sites:   string[];
}

export interface AppState {
  timer:      TimerState;
  blockState: BlockState;
}

export interface AppSettings {
  focusDuration:      number;
  breakDuration:      number;
  longBreakDuration:  number;
}

export type BgMessage =
  | { type: 'getState' }
  | { type: 'timerStart' }
  | { type: 'timerPause' }
  | { type: 'timerReset' }
  | { type: 'timerSkip' }
  | { type: 'timerSetMode';        mode: TimerMode }
  | { type: 'timerAddMinute' }
  | { type: 'timerUpdateSettings'; focusDuration?: number; breakDuration?: number; longBreakDuration?: number }
  | { type: 'setBlockEnabled';     enabled: boolean }
  | { type: 'setBlockedSites';     sites: string[] };

export type UiMessage =
  | { type: 'stateUpdate'; state: AppState; event?: string }
  | { type: 'blockStateUpdate'; blockState: BlockState };
