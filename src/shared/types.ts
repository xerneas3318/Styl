// ── Domain types ──────────────────────────────────────────────────────────────

export type TaskStatus   = 'todo' | 'in_progress' | 'done';
export type TaskPriority = 'low' | 'medium' | 'high';
export type TaskSource   = 'manual' | 'gmail' | 'ai' | 'screenshot';
export type TimerMode    = 'focus' | 'break' | 'longBreak';
export type AIProvider   = 'openai' | 'anthropic';

export interface Task {
  id: string;
  title: string;
  status: TaskStatus;
  priority: TaskPriority;
  estimated_duration_minutes?: number;
  due_date?: string;           // ISO date YYYY-MM-DD
  project?: string;
  source: TaskSource;
  notes?: string;
  created_at: string;          // ISO datetime
  updated_at: string;
}

export interface Memory {
  preferences:      Record<string, unknown>;
  recurring_events: Array<{ name: string; pattern: string }>;
  habits:           string[];
  task_patterns:    Record<string, unknown>;
  known_entities:   Record<string, string>;
}

export interface CalendarEvent {
  id:           string;
  title:        string;
  start:        string;        // ISO datetime
  end:          string;
  description?: string;
}

// ── Timer ─────────────────────────────────────────────────────────────────────

export interface TimerState {
  mode:                 TimerMode;
  isRunning:            boolean;
  /** Epoch ms when the current run started; null when paused. */
  startTime:            number | null;
  /** Seconds remaining at the moment the timer was last paused / created. */
  pausedTimeRemaining:  number;
  /** Denominator for the ring — grows when +1 min is added. */
  sessionTotal:         number;
  focusDuration:        number;   // seconds
  breakDuration:        number;
  longBreakDuration:    number;
  sessionsCompleted:    number;
}

// ── Config ────────────────────────────────────────────────────────────────────

export interface GitHubConfig {
  owner:    string;
  repo:     string;
  token:    string;
  branch:   string;
  clientId?: string;   // GitHub OAuth App client_id (for Device Flow setup)
}

export interface AIConfig {
  provider: AIProvider;
  apiKey:   string;
  model:    string;
}

export interface GoogleConfig {
  clientId:       string;
  clientSecret:   string;
  accessToken?:   string;
  refreshToken?:  string;
  tokenExpiry?:   number;   // epoch ms
  gmailEnabled:   boolean;
  calendarEnabled: boolean;
}

export interface AppSettings {
  github:          GitHubConfig | null;
  ai:              AIConfig | null;
  google:          GoogleConfig | null;
  autoApproveAI:   boolean;
  focusDuration:   number;
  breakDuration:   number;
  longBreakDuration: number;
}

// ── Application state ─────────────────────────────────────────────────────────

export interface BlockState {
  enabled: boolean;
  sites:   string[];
}

export interface AppState {
  tasks:         Task[];
  memory:        Memory;
  calendarCache: CalendarEvent[];
  timer:         TimerState;
  blockState:    BlockState;
  lastSyncedAt:  string | null;
}

// ── Version control ───────────────────────────────────────────────────────────

export interface Snapshot {
  id:        string;
  timestamp: string;
  tasks:     Task[];
  memory:    Memory;
}

export interface TaskDiff {
  added:    Task[];
  removed:  Task[];
  modified: Array<{ before: Task; after: Task }>;
}

export interface LogEntry {
  timestamp:         string;
  user_prompt:       string;
  ai_actions_taken:  string[];
  files_changed:     string[];
}

// ── AI ────────────────────────────────────────────────────────────────────────

export type AIActionType =
  | 'create_task'
  | 'update_task'
  | 'delete_task'
  | 'reorder_tasks'
  | 'update_memory'
  | 'plan_day'
  | 'create_calendar_event';

export interface AIAction {
  type:    AIActionType;
  payload: unknown;
}

export interface AIResponse {
  message:          string;
  actions:          AIAction[];
  requiresApproval: boolean;
}

// ── Messages (background ↔ UI) ────────────────────────────────────────────────

export type BgMessage =
  | { type: 'getState' }
  | { type: 'timerStart' }
  | { type: 'timerPause' }
  | { type: 'timerReset' }
  | { type: 'timerSkip' }
  | { type: 'timerSetMode';        mode: TimerMode }
  | { type: 'timerAddMinute' }
  | { type: 'timerUpdateSettings'; focusDuration?: number; breakDuration?: number; longBreakDuration?: number }
  | { type: 'createTask';          task: Task }
  | { type: 'updateTask';          task: Task }
  | { type: 'deleteTask';          id: string }
  | { type: 'aiCommand';           prompt: string; imageData?: string }
  | { type: 'aiApprove';           response: AIResponse; prompt: string }
  | { type: 'aiReject' }
  | { type: 'undoLast' }
  | { type: 'revertToSnapshot';    snapshotId: string }
  | { type: 'syncNow' }
  | { type: 'settingsUpdated';     settings: AppSettings }
  | { type: 'setBlockEnabled';     enabled: boolean }
  | { type: 'setBlockedSites';     sites: string[] }
  | { type: 'gmailScan' };

export type UiMessage =
  | { type: 'stateUpdate';        state: AppState; event?: string }
  | { type: 'blockStateUpdate';   blockState: BlockState }
  | { type: 'aiThinking' }
  | { type: 'aiComplete';         message: string }
  | { type: 'aiPendingApproval';  response: AIResponse; diff: TaskDiff }
  | { type: 'aiRejected' }
  | { type: 'undoComplete' }
  | { type: 'syncComplete' }
  | { type: 'error';              message: string }
  | { type: 'gmailMessages';      messages: unknown[] };
