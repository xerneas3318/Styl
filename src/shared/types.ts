export type TimerMode = 'focus' | 'break' | 'longBreak';
export type BlockGate = 'none' | 'confirm' | 'password';

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
  enabled:        boolean;
  alwaysSites:    string[];  // blocked all the time
  focusSites:     string[];  // blocked only during focus timer
  gate:           BlockGate; // 'none' = hard block, 'confirm' = are you sure, 'password' = pin
  bypassPassword: string;    // only used when gate === 'password'
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
  | { type: 'setAlwaysSites';      sites: string[] }
  | { type: 'setFocusSites';       sites: string[] }
  | { type: 'setBlockGate';        gate: BlockGate; password?: string }
  | { type: 'requestBypass';       site: string }
  | { type: 'checkBypassPassword'; password: string }
  | { type: 'getTimerState' }
  | { type: 'getBlockState' };

export type UiMessage =
  | { type: 'stateUpdate'; state: AppState; event?: string }
  | { type: 'blockStateUpdate'; blockState: BlockState };
