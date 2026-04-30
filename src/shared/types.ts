export type TimerMode = 'focus' | 'break' | 'longBreak';
export type BlockMode = 'focus' | 'always';
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
  enabled:          boolean;
  sites:            string[];
  blockMode:        BlockMode;  // 'focus' = only during focus timer, 'always' = all the time
  gate:             BlockGate;  // 'none' = hard block, 'confirm' = are you sure, 'password' = pin
  bypassPassword:   string;     // empty when gate !== 'password'
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
  | { type: 'setBlockedSites';     sites: string[] }
  | { type: 'setBlockMode';        mode: BlockMode }
  | { type: 'setBlockGate';        gate: BlockGate; password?: string }
  | { type: 'checkBypassPassword'; password: string }
  | { type: 'getTimerState' }
  | { type: 'getBlockState' };

export type UiMessage =
  | { type: 'stateUpdate'; state: AppState; event?: string }
  | { type: 'blockStateUpdate'; blockState: BlockState };
