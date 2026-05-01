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

export interface BlockPresets {
  social: string[];
  video:  string[];
  news:   string[];
}

export interface BlockState {
  enabled:        boolean;
  alwaysSites:    string[];
  focusSites:     string[];
  gate:           BlockGate;
  bypassPassword: string;
  presets:        BlockPresets;
}

export interface AppState {
  timer:      TimerState;
  blockState: BlockState;
}

export type ThemeMode = 'dark' | 'light' | 'system';
export type FontSize  = 'small' | 'medium' | 'large';

export interface AppSettings {
  focusDuration:     number;
  breakDuration:     number;
  longBreakDuration: number;
  theme:             ThemeMode;
  fontSize:          FontSize;
  apiKey:            string;
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
  | { type: 'setPresets';          presets: BlockPresets }
  | { type: 'requestBypass';       site: string }
  | { type: 'checkBypassPassword'; password: string }
  | { type: 'getTimerState' }
  | { type: 'getBlockState' };

export type UiMessage =
  | { type: 'stateUpdate'; state: AppState; event?: string }
  | { type: 'blockStateUpdate'; blockState: BlockState };
