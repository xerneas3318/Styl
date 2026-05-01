# Styl

A browser extension (Firefox + Chrome) with a Pomodoro timer, always-on site blocker, and a custom new tab page.

## Features

**Focus timer** — Pomodoro-style with Focus, Short Break, and Long Break modes. Click the timer to set any duration or pick from presets. A progress ring counts down and a chime plays when the session ends. A +1 min button appears while running for those moments you need just a little more time.

**Site blocking** — Block sites always, or only during focus sessions. Tabs already open on blocked sites get redirected immediately, not just new navigations. Three bypass modes: hard block, confirmation prompt, or password gate. Comes with Social, Video, and News presets — all editable.

**Extension badge** — Remaining minutes show on the extension icon while a timer is running so you always know where you are without opening the popup.

**Sound control** — Mute the completion chime and OS notification with a single click in the popup.

**Themes** — Dark, Light, or System (follows OS preference). Small, Medium, and Large font sizes.

**New tab page** — The extension replaces the new tab with a minimal clock and timer view so everything is one Cmd+T away.

## Install

### Firefox

1. Clone the repo
2. Open `about:debugging` → **This Firefox** → **Load Temporary Add-on**
3. Select `manifest.json`

### Chrome

1. Clone the repo
2. Run `npm install && npm run build:chrome`
3. Open `chrome://extensions` → enable **Developer mode** → **Load unpacked**
4. Select the repo folder

## Build

```bash
npm install

npm run build          # Firefox (default)
npm run build:chrome   # Chrome

npm run watch          # Firefox watch mode
npm run watch:chrome   # Chrome watch mode
```

Each build writes the correct `manifest.json` for the target browser.

## Settings

Open the settings page from the gear icon in the popup. Configure timer durations, appearance, and your Anthropic API key (optional — reserved for future features).

## License

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
