import { Storage } from './storage';
import type { AppSettings } from './types';

export function applyThemeFromSettings(s: Partial<AppSettings>): void {
  const theme    = s.theme    ?? 'dark';
  const fontSize = s.fontSize ?? 'medium';
  const html = document.documentElement;

  const isLight = theme === 'light' ||
    (theme === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
  html.classList.toggle('theme-light', isLight);

  html.classList.remove('size-small', 'size-medium', 'size-large');
  html.classList.add(`size-${fontSize}`);
}

export async function applyTheme(): Promise<void> {
  const s = await Storage.getSettings();
  applyThemeFromSettings(s ?? {});
  if (s?.theme === 'system') {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      applyThemeFromSettings(s);
    });
  }
}
