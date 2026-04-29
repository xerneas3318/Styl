import type { Task, Memory, Snapshot, TaskDiff, LogEntry } from '../shared/types';
import { generateId, isoNow } from '../shared/utils';
import { Storage } from '../shared/storage';
import type { GitHubClient } from './github';

export function createSnapshot(tasks: Task[], memory: Memory): Snapshot {
  return {
    id:        generateId(),
    timestamp: isoNow(),
    tasks:     JSON.parse(JSON.stringify(tasks)) as Task[],
    memory:    JSON.parse(JSON.stringify(memory)) as Memory,
  };
}

export function computeDiff(before: Task[], after: Task[]): TaskDiff {
  const beforeMap = new Map(before.map((t) => [t.id, t]));
  const afterMap  = new Map(after.map((t)  => [t.id, t]));

  return {
    added:    after.filter((t) => !beforeMap.has(t.id)),
    removed:  before.filter((t) => !afterMap.has(t.id)),
    modified: after
      .filter((t) => beforeMap.has(t.id) && JSON.stringify(beforeMap.get(t.id)) !== JSON.stringify(t))
      .map((t)  => ({ before: beforeMap.get(t.id)!, after: t })),
  };
}

export function isDiffEmpty(diff: TaskDiff): boolean {
  return diff.added.length === 0 && diff.removed.length === 0 && diff.modified.length === 0;
}

/**
 * Save snapshot locally + fire-and-forget GitHub sync.
 * Never awaited by the caller — UI stays responsive.
 */
export async function commitChange(
  gh:          GitHubClient,
  beforeTasks: Task[],
  afterTasks:  Task[],
  memory:      Memory,
  prompt:      string,
  actionTypes: string[],
): Promise<void> {
  const snapshot = createSnapshot(afterTasks, memory);
  const diff     = computeDiff(beforeTasks, afterTasks);

  // Persist snapshot locally first (fast)
  await Storage.pushSnapshot(snapshot);

  // Sync to GitHub in the background
  const commitMsg = `ai: ${prompt.slice(0, 72)}`;
  const log: LogEntry = {
    timestamp:        isoNow(),
    user_prompt:      prompt,
    ai_actions_taken: actionTypes,
    files_changed:    ['tasks.json', 'memory.json'],
  };

  Promise.all([
    gh.writeTasks(afterTasks, commitMsg),
    gh.writeMemory(memory,    commitMsg),
    gh.saveSnapshot(snapshot),
    !isDiffEmpty(diff) ? gh.saveDiff(snapshot.id, diff) : Promise.resolve(),
    gh.appendLog(log),
  ]).catch((e) => console.error('[styl] GitHub sync error:', e));
}
