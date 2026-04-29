import type { GitHubConfig, Task, Memory, Snapshot, TaskDiff, LogEntry } from '../shared/types';
import { todayStr } from '../shared/utils';

const GITHUB_API = 'https://api.github.com';

interface GHFile {
  content: string;
  sha:     string;
}

function defaultMemory(): Memory {
  return {
    preferences:      {},
    recurring_events: [],
    habits:           [],
    task_patterns:    {},
    known_entities:   {},
  };
}

export class GitHubClient {
  constructor(private cfg: GitHubConfig) {}

  private get headers(): HeadersInit {
    return {
      Authorization:          `Bearer ${this.cfg.token}`,
      Accept:                 'application/vnd.github+json',
      'Content-Type':         'application/json',
      'X-GitHub-Api-Version': '2022-11-28',
    };
  }

  private url(path: string): string {
    return `${GITHUB_API}/repos/${this.cfg.owner}/${this.cfg.repo}${path}`;
  }

  private async req<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method,
      headers: this.headers,
      body:    body ? JSON.stringify(body) : undefined,
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`GitHub ${method} ${path} → ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  }

  async getFile(path: string): Promise<GHFile | null> {
    try {
      const data = await this.req<{ content: string; sha: string }>(
        'GET', `/contents/${path}?ref=${this.cfg.branch}`
      );
      return {
        content: decodeURIComponent(escape(atob(data.content.replace(/\n/g, '')))),
        sha:     data.sha,
      };
    } catch {
      return null;
    }
  }

  async putFile(path: string, content: string, message: string, sha?: string): Promise<void> {
    await this.req('PUT', `/contents/${path}`, {
      message,
      content: btoa(unescape(encodeURIComponent(content))),
      branch:  this.cfg.branch,
      ...(sha ? { sha } : {}),
    });
  }

  private async readJSON<T>(path: string, fallback: T): Promise<T> {
    const file = await this.getFile(path);
    if (!file) return fallback;
    try   { return JSON.parse(file.content) as T; }
    catch { return fallback; }
  }

  private async writeJSON(path: string, data: unknown, message: string): Promise<void> {
    const file = await this.getFile(path);
    await this.putFile(path, JSON.stringify(data, null, 2), message, file?.sha);
  }

  // ── Domain helpers ─────────────────────────────────────────────────────────

  readTasks  = () => this.readJSON<Task[]>('tasks.json', []);
  readMemory = () => this.readJSON<Memory>('memory.json', defaultMemory());

  writeTasks  = (tasks: Task[],  msg: string) => this.writeJSON('tasks.json',  tasks,  msg);
  writeMemory = (memory: Memory, msg: string) => this.writeJSON('memory.json', memory, msg);

  async appendLog(entry: LogEntry): Promise<void> {
    const path = `logs/${todayStr()}.json`;
    const file = await this.getFile(path);
    const prev: LogEntry[] = file ? (JSON.parse(file.content) as LogEntry[]) : [];
    prev.push(entry);
    await this.putFile(path, JSON.stringify(prev, null, 2), `log: ${entry.timestamp}`, file?.sha);
  }

  saveSnapshot = (snap: Snapshot) =>
    this.writeJSON(`snapshots/snapshot-${snap.id}.json`, snap, `snapshot: ${snap.id}`);

  saveDiff = (id: string, d: TaskDiff) =>
    this.writeJSON(`diffs/diff-${id}.json`, d, `diff: ${id}`);

  /** Creates the repo if it doesn't already exist (422 = already exists → fine). */
  async createRepo(name: string): Promise<void> {
    const res = await fetch(`${GITHUB_API}/user/repos`, {
      method:  'POST',
      headers: {
        Authorization:          `Bearer ${this.cfg.token}`,
        Accept:                 'application/vnd.github+json',
        'Content-Type':         'application/json',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      body: JSON.stringify({
        name,
        private:     true,
        description: 'Styl browser extension data',
        auto_init:   true,   // creates an initial commit so the branch exists
      }),
    });
    if (!res.ok && res.status !== 422) {
      const data = await res.json().catch(() => ({ message: res.statusText }));
      throw new Error((data as { message?: string }).message ?? 'Could not create repo');
    }
  }

  async testConnection(): Promise<{ ok: boolean; error?: string }> {
    try { await this.req('GET', ''); return { ok: true }; }
    catch (e) { return { ok: false, error: (e as Error).message }; }
  }

  async bootstrap(): Promise<void> {
    const [tasks, memory] = await Promise.all([
      this.getFile('tasks.json'),
      this.getFile('memory.json'),
    ]);
    const writes: Promise<void>[] = [];
    if (!tasks)  writes.push(this.putFile('tasks.json',  '[]',                                   'init: tasks'));
    if (!memory) writes.push(this.putFile('memory.json', JSON.stringify(defaultMemory(), null, 2), 'init: memory'));
    await Promise.all(writes);
  }
}
