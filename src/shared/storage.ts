import type { AppState, AppSettings } from './types';

const KEY_STATE    = 'styl_state';
const KEY_SETTINGS = 'styl_settings';

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
};
