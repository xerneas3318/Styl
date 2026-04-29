import type { AppState, AppSettings, Snapshot } from './types';

const KEY_STATE     = 'styl_state';
const KEY_SETTINGS  = 'styl_settings';
const KEY_SNAPSHOTS = 'styl_snapshots';
const MAX_SNAPSHOTS = 50;

async function get<T>(key: string): Promise<T | null> {
  const result = await browser.storage.local.get(key);
  return (result[key] as T) ?? null;
}

function set(key: string, value: unknown): Promise<void> {
  return browser.storage.local.set({ [key]: value });
}

export const Storage = {
  getState:    () => get<AppState>(KEY_STATE),
  setState:    (s: AppState) => set(KEY_STATE, s),

  getSettings: () => get<AppSettings>(KEY_SETTINGS),
  setSettings: (s: AppSettings) => set(KEY_SETTINGS, s),

  getSnapshots: () =>
    get<Snapshot[]>(KEY_SNAPSHOTS).then((s) => s ?? []),

  setSnapshots: (s: Snapshot[]) => set(KEY_SNAPSHOTS, s),

  async pushSnapshot(snap: Snapshot): Promise<void> {
    const snaps = await Storage.getSnapshots();
    snaps.unshift(snap);
    if (snaps.length > MAX_SNAPSHOTS) snaps.length = MAX_SNAPSHOTS;
    await Storage.setSnapshots(snaps);
  },
};
