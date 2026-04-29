import type { AIConfig, AIAction, AIResponse, Task, Memory, CalendarEvent } from '../shared/types';
import { generateId, isoNow } from '../shared/utils';

// ── System prompt ─────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are a deterministic personal planning assistant embedded in a browser extension.
You manage tasks, memory, and calendar. Return ONLY valid JSON — no markdown, no prose wrappers.

Output schema:
{
  "message": "1-2 line confirmation (terse)",
  "actions": [ ...AIAction ],
  "requiresApproval": false
}

Action types and their payload shapes:
  create_task        { title, status?, priority?, estimated_duration_minutes?, due_date?, project?, source?, notes? }
  update_task        { id, ...fields }
  delete_task        { id }
  reorder_tasks      { orderedIds: string[] }
  plan_day           { orderedTasks: Array<{ id, estimated_duration_minutes? }> }
  update_memory      { path: "dot.separated.key", value: any }
  create_calendar_event { title, start (ISO), end (ISO), description? }

Rules:
- requiresApproval = true only for bulk deletes or explicit destructive rewrites
- Tasks are flexible work. Calendar events are fixed-time appointments only.
- Infer priority from urgency language: "urgent/asap/due today" → high, "sometime" → low
- When asked to "plan my day", reorder todo tasks by priority+duration fit, fill in durations
- "mark X done" → update_task with status:"done"
- Extract tasks from screenshot text literally — preserve exact wording`;

// ── AI Client ─────────────────────────────────────────────────────────────────

export class AIClient {
  constructor(private cfg: AIConfig) {}

  async sendCommand(
    prompt:        string,
    tasks:         Task[],
    memory:        Memory,
    calendar:      CalendarEvent[],
    imageData?:    string,
  ): Promise<AIResponse> {
    const context = buildContext(tasks, memory, calendar);
    return this.cfg.provider === 'anthropic'
      ? this.callAnthropic(prompt, context, imageData)
      : this.callOpenAI(prompt, context, imageData);
  }

  private async callAnthropic(
    prompt:     string,
    context:    string,
    imageData?: string,
  ): Promise<AIResponse> {
    const content: unknown[] = [];
    if (imageData) {
      content.push({
        type:   'image',
        source: { type: 'base64', media_type: 'image/png', data: imageData },
      });
    }
    content.push({ type: 'text', text: `${context}\n\nUser: ${prompt}` });

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method:  'POST',
      headers: {
        'x-api-key':          this.cfg.apiKey,
        'anthropic-version':  '2023-06-01',
        'content-type':       'application/json',
      },
      body: JSON.stringify({
        model:      this.cfg.model || 'claude-haiku-4-5-20251001',
        max_tokens: 2048,
        system:     SYSTEM_PROMPT,
        messages:   [{ role: 'user', content }],
      }),
    });

    if (!res.ok) throw new Error(`Anthropic API error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { content: Array<{ text: string }> };
    return parseAIResponse(data.content[0].text);
  }

  private async callOpenAI(
    prompt:     string,
    context:    string,
    imageData?: string,
  ): Promise<AIResponse> {
    const userContent: unknown[] = [];
    if (imageData) {
      userContent.push({
        type:      'image_url',
        image_url: { url: `data:image/png;base64,${imageData}` },
      });
    }
    userContent.push({ type: 'text', text: `${context}\n\nUser: ${prompt}` });

    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method:  'POST',
      headers: {
        Authorization:  `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model:           this.cfg.model || 'gpt-4o-mini',
        messages:        [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user',   content: userContent },
        ],
        max_tokens:      2048,
        response_format: { type: 'json_object' },
      }),
    });

    if (!res.ok) throw new Error(`OpenAI API error ${res.status}: ${await res.text()}`);
    const data = await res.json() as { choices: Array<{ message: { content: string } }> };
    return parseAIResponse(data.choices[0].message.content);
  }
}

// ── Action application ────────────────────────────────────────────────────────

export interface ApplyResult {
  tasks:            Task[];
  memory:           Memory;
  calendarRequests: Array<{ title: string; start: string; end: string; description?: string }>;
}

export function applyActions(
  tasks:   Task[],
  memory:  Memory,
  actions: AIAction[],
): ApplyResult {
  let newTasks  = [...tasks];
  const newMem  = JSON.parse(JSON.stringify(memory)) as Memory;
  const calReqs: ApplyResult['calendarRequests'] = [];

  for (const action of actions) {
    switch (action.type) {

      case 'create_task': {
        const p = action.payload as Partial<Task>;
        newTasks.push({
          id:         generateId(),
          title:      p.title ?? 'Untitled',
          status:     p.status   ?? 'todo',
          priority:   p.priority ?? 'medium',
          source:     p.source   ?? 'ai',
          estimated_duration_minutes: p.estimated_duration_minutes,
          due_date:   p.due_date,
          project:    p.project,
          notes:      p.notes,
          created_at: isoNow(),
          updated_at: isoNow(),
        });
        break;
      }

      case 'update_task': {
        const p = action.payload as Partial<Task> & { id: string };
        newTasks = newTasks.map((t) =>
          t.id === p.id ? { ...t, ...p, updated_at: isoNow() } : t
        );
        break;
      }

      case 'delete_task': {
        const { id } = action.payload as { id: string };
        newTasks = newTasks.filter((t) => t.id !== id);
        break;
      }

      case 'reorder_tasks': {
        const { orderedIds } = action.payload as { orderedIds: string[] };
        const map = new Map(newTasks.map((t) => [t.id, t]));
        newTasks = orderedIds.map((id) => map.get(id)).filter(Boolean) as Task[];
        break;
      }

      case 'plan_day': {
        const { orderedTasks } = action.payload as {
          orderedTasks: Array<{ id: string; estimated_duration_minutes?: number }>;
        };
        const idxMap = new Map(orderedTasks.map((t, i) => [t.id, i]));
        const durMap = new Map(
          orderedTasks
            .filter((t) => t.estimated_duration_minutes != null)
            .map((t) => [t.id, t.estimated_duration_minutes as number])
        );
        newTasks = [...newTasks].sort((a, b) =>
          (idxMap.get(a.id) ?? 999) - (idxMap.get(b.id) ?? 999)
        );
        newTasks = newTasks.map((t) =>
          durMap.has(t.id)
            ? { ...t, estimated_duration_minutes: durMap.get(t.id), updated_at: isoNow() }
            : t
        );
        break;
      }

      case 'update_memory': {
        const { path, value } = action.payload as { path: string; value: unknown };
        setNested(newMem as unknown as Record<string, unknown>, path, value);
        break;
      }

      case 'create_calendar_event': {
        calReqs.push(action.payload as ApplyResult['calendarRequests'][0]);
        break;
      }
    }
  }

  return { tasks: newTasks, memory: newMem, calendarRequests: calReqs };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function buildContext(tasks: Task[], memory: Memory, calendar: CalendarEvent[]): string {
  return [
    `Tasks (${tasks.length}):\n${JSON.stringify(tasks, null, 2)}`,
    `Memory:\n${JSON.stringify(memory, null, 2)}`,
    `Today's calendar (${calendar.length} events):\n${JSON.stringify(calendar, null, 2)}`,
  ].join('\n\n');
}

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
