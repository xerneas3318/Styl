import type { AIConfig, AIAction, AIResponse, Task, Memory, CalendarEvent } from '../shared/types';
import { generateId, isoNow } from '../shared/utils';

// ── Calendar tool ─────────────────────────────────────────────────────────────

export type CalendarFetcher = (startDate: string, endDate: string) => Promise<CalendarEvent[]>;

const CAL_TOOL_DESC =
  'Fetch Google Calendar events for any date range. Use this for specific future dates, scheduling questions, or availability checks — especially beyond the next 14 days.';

const ANTHROPIC_CAL_TOOL = {
  name: 'get_calendar_events',
  description: CAL_TOOL_DESC,
  input_schema: {
    type: 'object',
    properties: {
      start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
      end_date:   { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
    },
    required: ['start_date', 'end_date'],
  },
};

const OPENAI_CAL_TOOL = {
  type: 'function',
  function: {
    name: 'get_calendar_events',
    description: CAL_TOOL_DESC,
    parameters: {
      type: 'object',
      properties: {
        start_date: { type: 'string', description: 'Start date YYYY-MM-DD' },
        end_date:   { type: 'string', description: 'End date YYYY-MM-DD (inclusive)' },
      },
      required: ['start_date', 'end_date'],
    },
  },
};

// ── System prompt ─────────────────────────────────────────────────────────────

function buildSystemPrompt(): string {
  const now     = new Date();
  const dateStr = now.toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });

  const nowIso  = now.toISOString();

  return `You are a personal planning assistant embedded in a browser extension called Styl.
RIGHT NOW: ${dateStr} at ${timeStr} (${nowIso})

You manage tasks, persistent memory, and Google Calendar. Always return ONLY valid JSON — no markdown fences, no prose wrappers.

OUTPUT SCHEMA:
{
  "message": "<your response to the user — can be multiple lines, use \\n for line breaks>",
  "actions": [ { "type": "<action_type>", "payload": { ...fields } } ],
  "requiresApproval": false
}

AVAILABLE ACTIONS:
  create_task           payload: { title, status?, priority?, estimated_duration_minutes?, due_date? (YYYY-MM-DD), project?, notes? }
  update_task           payload: { id, ...fields to update }
  delete_task           payload: { id }
  reorder_tasks         payload: { orderedIds: ["id1","id2",...] }
  plan_day              payload: { orderedTasks: [{ id, estimated_duration_minutes? }] }
  update_memory         payload: { path: "dot.key.path", value: <any> }
  add_fact              payload: { text: "concise atomic fact about the user" }
  create_calendar_event payload: { title, start (ISO datetime), end (ISO datetime), description? }
  delete_calendar_event payload: { id }

RULES:
- requiresApproval = true ONLY for 3+ simultaneous deletes
- Tasks = flexible to-do items with no fixed time. Calendar events = fixed-time appointments only.
- Priority inference: "urgent/asap/critical/due today" → high · "sometime/eventually" → low · default → medium
- ALWAYS call add_fact when you learn anything new about the user: schedule, preferences, habits, projects, people — this builds your long-term model of them.
- For calendar questions beyond 14 days away, use the get_calendar_events tool.
- Extract tasks from screenshots literally — preserve exact wording.

PLANNING ("plan my day" or similar):
  1. Determine start time: use work_hours from memory if set, otherwise use current time (${timeStr}) as start.
  2. Build a time-blocked schedule by slotting todo tasks into the day in this order: high priority → due date soonest → medium priority → low priority. Assign realistic durations (default: 25–45 min for focused tasks, 5–15 min for quick tasks) if not already set.
  3. Treat every calendar event today as a fixed block — do not schedule tasks during those times. Show them in the schedule too.
  4. Factor in breaks: 5–10 min after every 1–2 tasks, longer break mid-day if schedule allows.
  5. Write the full time-blocked schedule in the message field, like:
       9:00 AM  ▸ Task name (30 min)
       9:35 AM  ▸ Another task (45 min)
      10:20 AM  📅 Team standup [calendar] (30 min)
      10:50 AM  ▸ Next task (25 min)
       ...
  6. Emit ONE plan_day action with the task order and updated durations. Don't emit individual update_task actions for duration — plan_day handles that.
  7. End the message with a one-line motivational note tailored to the day's workload.`;
}

// ── AI Client ─────────────────────────────────────────────────────────────────

export class AIClient {
  constructor(private cfg: AIConfig) {}

  async sendCommand(
    prompt:         string,
    tasks:          Task[],
    memory:         Memory,
    calendar:       CalendarEvent[],
    imageData?:     string,
    fetchCalendar?: CalendarFetcher,
  ): Promise<AIResponse> {
    const context = buildContext(tasks, memory, calendar);
    return this.cfg.provider === 'anthropic'
      ? this.callAnthropic(prompt, context, imageData, fetchCalendar)
      : this.callOpenAI(prompt, context, imageData, fetchCalendar);
  }

  private async callAnthropic(
    prompt:         string,
    context:        string,
    imageData?:     string,
    fetchCalendar?: CalendarFetcher,
  ): Promise<AIResponse> {
    const content: unknown[] = [];
    if (imageData) {
      content.push({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: imageData } });
    }
    content.push({ type: 'text', text: `${context}\n\nUser: ${prompt}` });

    const messages: unknown[] = [{ role: 'user', content }];
    const tools = fetchCalendar ? [ANTHROPIC_CAL_TOOL] : undefined;

    for (let turn = 0; turn < 5; turn++) {
      const body: Record<string, unknown> = {
        model:      this.cfg.model || 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system:     buildSystemPrompt(),
        messages,
      };
      if (tools) body.tools = tools;

      const res = await fetch('https://api.anthropic.com/v1/messages', {
        method:  'POST',
        headers: {
          'x-api-key':         this.cfg.apiKey,
          'anthropic-version': '2023-06-01',
          'content-type':      'application/json',
        },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);

      const data = await res.json() as {
        stop_reason: string;
        content: Array<{ type: string; text?: string; id?: string; name?: string; input?: Record<string, string> }>;
      };

      if (data.stop_reason === 'tool_use' && fetchCalendar) {
        const toolUse = data.content.find((b) => b.type === 'tool_use');
        if (!toolUse) break;
        const { start_date, end_date } = toolUse.input as { start_date: string; end_date: string };
        const events = await fetchCalendar(start_date, end_date);
        messages.push({ role: 'assistant', content: data.content });
        messages.push({
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: toolUse.id, content: formatEventsForTool(events, start_date, end_date) }],
        });
        continue;
      }

      const textBlock = data.content.find((b) => b.type === 'text');
      if (textBlock?.text) return parseAIResponse(textBlock.text);
      break;
    }
    return { message: 'Done.', actions: [], requiresApproval: false };
  }

  private async callOpenAI(
    prompt:         string,
    context:        string,
    imageData?:     string,
    fetchCalendar?: CalendarFetcher,
  ): Promise<AIResponse> {
    const userContent: unknown[] = [];
    if (imageData) {
      userContent.push({ type: 'image_url', image_url: { url: `data:image/png;base64,${imageData}` } });
    }
    userContent.push({ type: 'text', text: `${context}\n\nUser: ${prompt}` });

    const messages: unknown[] = [
      { role: 'system', content: buildSystemPrompt() },
      { role: 'user',   content: userContent },
    ];
    const tools = fetchCalendar ? [OPENAI_CAL_TOOL] : undefined;

    for (let turn = 0; turn < 5; turn++) {
      const body: Record<string, unknown> = {
        model:      this.cfg.model || 'gpt-4o-mini',
        messages,
        max_tokens: 2048,
      };
      if (tools) body.tools = tools;
      else       body.response_format = { type: 'json_object' };

      const res = await fetch('https://api.openai.com/v1/chat/completions', {
        method:  'POST',
        headers: { Authorization: `Bearer ${this.cfg.apiKey}`, 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);

      const data = await res.json() as {
        choices: Array<{
          finish_reason: string;
          message: {
            role: string;
            content: string | null;
            tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
          };
        }>;
      };

      const choice = data.choices[0];
      if (choice.finish_reason === 'tool_calls' && fetchCalendar) {
        const call = choice.message.tool_calls?.[0];
        if (!call) break;
        const { start_date, end_date } = JSON.parse(call.function.arguments) as { start_date: string; end_date: string };
        const events = await fetchCalendar(start_date, end_date);
        // Push the exact message object returned by the API — reconstructing it
        // drops required fields and causes a 400 "tool_call_id not responded to"
        messages.push(choice.message);
        // Respond to every tool_call_id in the message, not just the first
        for (const tc of choice.message.tool_calls ?? []) {
          messages.push({ role: 'tool', tool_call_id: tc.id, content: formatEventsForTool(events, start_date, end_date) });
        }
        continue;
      }

      if (choice.message.content) return parseAIResponse(choice.message.content);
      break;
    }
    return { message: 'Done.', actions: [], requiresApproval: false };
  }
}

// ── Action application ────────────────────────────────────────────────────────

export interface ApplyResult {
  tasks:                  Task[];
  memory:                 Memory;
  calendarRequests:       Array<{ title: string; start: string; end: string; description?: string }>;
  calendarDeleteRequests: string[];
}

export function applyActions(
  tasks:   Task[],
  memory:  Memory,
  actions: AIAction[],
): ApplyResult {
  let newTasks  = [...tasks];
  const newMem  = JSON.parse(JSON.stringify(memory)) as Memory;
  if (!Array.isArray(newMem.facts)) newMem.facts = [];
  const calReqs:    ApplyResult['calendarRequests'] = [];
  const calDeletes: string[]                        = [];

  for (const rawAction of actions) {
    if (!rawAction.type) continue;
    // Normalise camelCase / kebab-case → snake_case
    const action = {
      ...rawAction,
      type: (rawAction.type as string)
        .replace(/([a-z])([A-Z])/g, '$1_$2')
        .toLowerCase()
        .replace(/-/g, '_') as typeof rawAction.type,
    };

    switch (action.type) {

      case 'create_task': {
        const p = (action.payload ?? action) as Partial<Task>;
        newTasks.push({
          id: generateId(), title: p.title ?? 'Untitled',
          status: p.status ?? 'todo', priority: p.priority ?? 'medium',
          source: p.source ?? 'ai',
          estimated_duration_minutes: p.estimated_duration_minutes,
          due_date: p.due_date, project: p.project, notes: p.notes,
          created_at: isoNow(), updated_at: isoNow(),
        });
        break;
      }

      case 'update_task': {
        const p = (action.payload ?? action) as Partial<Task> & { id: string };
        newTasks = newTasks.map((t) => t.id === p.id ? { ...t, ...p, updated_at: isoNow() } : t);
        break;
      }

      case 'delete_task': {
        const { id } = (action.payload ?? action) as { id: string };
        newTasks = newTasks.filter((t) => t.id !== id);
        break;
      }

      case 'reorder_tasks': {
        const { orderedIds } = (action.payload ?? action) as { orderedIds: string[] };
        const map = new Map(newTasks.map((t) => [t.id, t]));
        newTasks = orderedIds.map((id) => map.get(id)).filter(Boolean) as Task[];
        break;
      }

      case 'plan_day': {
        const { orderedTasks } = (action.payload ?? action) as {
          orderedTasks: Array<{ id: string; estimated_duration_minutes?: number }>;
        };
        const idxMap = new Map(orderedTasks.map((t, i) => [t.id, i]));
        const durMap = new Map(orderedTasks.filter((t) => t.estimated_duration_minutes != null).map((t) => [t.id, t.estimated_duration_minutes!]));
        newTasks = [...newTasks].sort((a, b) => (idxMap.get(a.id) ?? 999) - (idxMap.get(b.id) ?? 999));
        newTasks = newTasks.map((t) => durMap.has(t.id) ? { ...t, estimated_duration_minutes: durMap.get(t.id), updated_at: isoNow() } : t);
        break;
      }

      case 'update_memory': {
        const { path, value } = (action.payload ?? action) as { path: string; value: unknown };
        setNested(newMem as unknown as Record<string, unknown>, path, value);
        break;
      }

      case 'add_fact': {
        const { text } = (action.payload ?? action) as { text: string };
        if (text && !newMem.facts.includes(text)) newMem.facts.push(text);
        break;
      }

      case 'create_calendar_event': {
        calReqs.push((action.payload ?? action) as ApplyResult['calendarRequests'][0]);
        break;
      }

      case 'delete_calendar_event': {
        const { id } = (action.payload ?? action) as { id: string };
        calDeletes.push(id);
        break;
      }
    }
  }

  return { tasks: newTasks, memory: newMem, calendarRequests: calReqs, calendarDeleteRequests: calDeletes };
}

// ── Context builder ───────────────────────────────────────────────────────────

function buildContext(tasks: Task[], memory: Memory, calendar: CalendarEvent[]): string {
  const parts: string[] = [];

  // ── Tasks ──
  const todo   = tasks.filter((t) => t.status !== 'done');
  const done   = tasks.filter((t) => t.status === 'done');
  const byPri  = (p: string) => todo.filter((t) => t.priority === p);

  const fmtTask = (t: Task) => {
    let s = `    [${t.id}] ${t.title}`;
    if (t.estimated_duration_minutes) s += ` — ${t.estimated_duration_minutes}min`;
    if (t.due_date) s += ` · due ${t.due_date}`;
    if (t.project)  s += ` · #${t.project}`;
    if (t.notes)    s += `\n      notes: ${t.notes}`;
    return s;
  };

  const taskLines = [`TASKS  (${todo.length} todo, ${done.length} done)`];
  if (byPri('high').length)   { taskLines.push('  HIGH PRIORITY:');   byPri('high').forEach((t)   => taskLines.push(fmtTask(t))); }
  if (byPri('medium').length) { taskLines.push('  MEDIUM PRIORITY:'); byPri('medium').forEach((t) => taskLines.push(fmtTask(t))); }
  if (byPri('low').length)    { taskLines.push('  LOW PRIORITY:');    byPri('low').forEach((t)    => taskLines.push(fmtTask(t))); }
  if (done.length)            taskLines.push(`  COMPLETED (${done.length}): ${done.map((t) => t.title).join(' · ')}`);
  if (todo.length === 0)      taskLines.push('  (no open tasks)');
  parts.push(taskLines.join('\n'));

  // ── Calendar ──
  const calLines = ['CALENDAR'];
  if (calendar.length) {
    const now      = new Date();
    const todayKey = dateKey(now);
    const todayEvt = calendar.filter((e) => dateKey(new Date(e.start)) === todayKey);
    const upcoming = calendar.filter((e) => dateKey(new Date(e.start)) > todayKey).slice(0, 12);

    const fmtEvt = (e: CalendarEvent) => {
      const start = new Date(e.start);
      const end   = new Date(e.end);
      const time  = e.start.includes('T')
        ? start.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })
        : 'All day';
      const durMin = e.start.includes('T')
        ? Math.round((end.getTime() - start.getTime()) / 60000)
        : 0;
      return `    ${time.padEnd(10)} ${e.title}${durMin ? ` (${durMin} min)` : ''}  [id:${e.id}]`;
    };

    if (todayEvt.length) {
      calLines.push(`  Today (${todayEvt.length} fixed block${todayEvt.length !== 1 ? 's' : ''} — work tasks around these):`);
      todayEvt.forEach((e) => calLines.push(fmtEvt(e)));
    } else {
      calLines.push('  Today: no events — full day available for tasks');
    }

    if (upcoming.length) {
      calLines.push('  Upcoming:');
      upcoming.forEach((e) => calLines.push(`    ${dateKey(new Date(e.start))}  ${e.title}`));
    }
  } else {
    calLines.push('  No events in cache — use get_calendar_events tool if needed');
  }
  parts.push(calLines.join('\n'));

  // ── Memory ──
  const memLines = ['MEMORY ABOUT USER'];
  let hasMemory  = false;

  if (memory.about_me) {
    memLines.push(`  About: ${memory.about_me}`);
    hasMemory = true;
  }
  if (memory.work_hours) {
    const wh = memory.work_hours as { start: string; end: string; days?: string[] };
    memLines.push(`  Work hours: ${wh.start} – ${wh.end}${wh.days ? ` (${wh.days.join(', ')})` : ''}`);
    hasMemory = true;
  }
  if (memory.habits?.length) {
    memLines.push(`  Habits: ${memory.habits.join(' · ')}`);
    hasMemory = true;
  }
  if (memory.recurring_events?.length) {
    memLines.push('  Recurring events:');
    memory.recurring_events.forEach((e) => memLines.push(`    - ${e.name}: ${e.pattern}`));
    hasMemory = true;
  }
  if (Object.keys(memory.preferences ?? {}).length) {
    memLines.push('  Preferences:');
    Object.entries(memory.preferences).forEach(([k, v]) => memLines.push(`    ${k}: ${v}`));
    hasMemory = true;
  }
  if (Object.keys(memory.known_entities ?? {}).length) {
    memLines.push('  People & projects:');
    Object.entries(memory.known_entities).forEach(([k, v]) => memLines.push(`    ${k}: ${v}`));
    hasMemory = true;
  }
  const facts = (memory.facts ?? []) as string[];
  if (facts.length) {
    memLines.push('  Learned facts:');
    facts.forEach((f) => memLines.push(`    • ${f}`));
    hasMemory = true;
  }

  if (!hasMemory) {
    memLines.push('  (none yet — save facts about the user with add_fact as you learn them)');
  }
  parts.push(memLines.join('\n'));

  return parts.join('\n\n');
}

function formatEventsForTool(events: CalendarEvent[], startDate: string, endDate: string): string {
  if (!events.length) return `No events found between ${startDate} and ${endDate}.`;
  return `Events from ${startDate} to ${endDate}:\n` +
    events.map((e) => {
      const time = e.start.includes('T')
        ? new Date(e.start).toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
        : `${e.start} (all day)`;
      return `  - ${time}: ${e.title}${e.description ? ` (${e.description})` : ''}`;
    }).join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function parseAIResponse(raw: string): AIResponse {
  const cleaned = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
  try {
    const parsed = JSON.parse(cleaned) as Partial<AIResponse>;
    return {
      message:          String(parsed.message ?? ''),
      actions:          Array.isArray(parsed.actions) ? parsed.actions : [],
      requiresApproval: parsed.requiresApproval === true,
    };
  } catch {
    return { message: raw.slice(0, 200), actions: [], requiresApproval: false };
  }
}

function setNested(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.');
  let cur = obj;
  for (let i = 0; i < parts.length - 1; i++) {
    if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
    cur = cur[parts[i]] as Record<string, unknown>;
  }
  cur[parts[parts.length - 1]] = value;
}

function dateKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
