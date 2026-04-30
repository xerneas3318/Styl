# Styl

A Firefox extension that turns your new tab into a personal planning and focus workspace.

I built this because every Pomodoro tool I found either put the useful stuff behind a paywall or just didn't have it. So I made my own, and then kept going.

It started as a timer. Now it has an AI assistant that actually understands your schedule, a full task manager with groups and drag and drop, live Google Calendar integration, and a site blocker that kicks in the moment you start a focus session. Everything lives on your new tab page so it's always one cmd+T away.

I was also just playing around with Claude and this is mostly vibecoded. My org gave me tokens I didn't have to pay for so I figured I'd use them to solve some personal problems. This is one of them.

## What it does

**Focus timer** — Pomodoro style with Focus, Short Break, and Long Break modes. Click the timer to set any duration or pick from presets. A progress ring counts down around the clock face and a chime plays when the session ends. A +1 min button appears while the timer is running for those moments when you just need a little more time.

**Site blocking** — When you start a focus session, any blocked sites redirect to a minimal blocked page that shows the remaining focus time counting down. Sites that are already open in other tabs get redirected too, not just new navigations. Comes with social, video, and news presets plus a fully custom list.

**AI assistant** — A full chat panel powered by your choice of Claude or GPT. You can ask it to plan your day and it will build a time blocked schedule from your tasks and calendar, slotting meetings in as fixed blocks and filling the gaps with your to do items in priority order. It remembers things you tell it across sessions using a persistent fact memory, so the more you use it the better it understands how you work. Supports image paste, slash commands, and conversation history navigation.

**Tasks** — Add tasks manually or let the AI create them. Group them by project with collapsible sections. Drag to reorder or drop one task onto another to merge them into a group. Click the priority dot to cycle between low, medium, and high. The AI can also read tasks from screenshots.

**Google Calendar** — Connects via OAuth and shows your events in a Day or Week view panel. The AI can create and delete calendar events, and it refreshes the panel automatically after any change. It can also query events far into the future by calling the Calendar API as a tool mid conversation.

**GitHub sync** — Optionally sync your task list and memory to a GitHub repo so nothing gets lost and you can access it across devices.

**Wallpaper** — Upload any image as a full quality background. The time of day theme underneath shifts automatically between night, morning, afternoon, and evening.

## Setup

Clone the repo, then open `about:debugging` in Firefox. Click **This Firefox**, then **Load Temporary Add-on**, and select `manifest.json`.

To use the AI features, open Settings from the task panel and paste in your Anthropic or OpenAI API key. Google Calendar and GitHub sync are optional and can also be configured there.

## License

[![License: CC BY-NC 4.0](https://img.shields.io/badge/License-CC%20BY--NC%204.0-lightgrey.svg)](https://creativecommons.org/licenses/by-nc/4.0/)
