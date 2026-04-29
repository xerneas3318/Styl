import type { CalendarEvent } from '../shared/types';

interface GCalEvent {
  id:      string;
  summary: string;
  start:   { dateTime?: string; date?: string };
  end:     { dateTime?: string; date?: string };
  description?: string;
}

export class CalendarClient {
  constructor(private accessToken: string) {}

  private get auth(): HeadersInit {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async getTodayEvents(): Promise<CalendarEvent[]> {
    const start = new Date(); start.setHours(0, 0, 0, 0);
    const end   = new Date(start); end.setDate(start.getDate() + 1);

    const params = new URLSearchParams({
      timeMin:      start.toISOString(),
      timeMax:      end.toISOString(),
      singleEvents: 'true',
      orderBy:      'startTime',
    });

    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events?${params}`,
      { headers: this.auth }
    );
    if (!res.ok) throw new Error(`Calendar list error ${res.status}`);

    const data = await res.json() as { items: GCalEvent[] };
    return (data.items ?? []).map((e) => ({
      id:          e.id,
      title:       e.summary ?? '(no title)',
      start:       e.start.dateTime ?? e.start.date ?? '',
      end:         e.end.dateTime   ?? e.end.date   ?? '',
      description: e.description,
    }));
  }

  async createEvent(event: {
    title:        string;
    start:        string;
    end:          string;
    description?: string;
  }): Promise<void> {
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method:  'POST',
        headers: { ...this.auth, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          summary:     event.title,
          description: event.description,
          start:       { dateTime: event.start },
          end:         { dateTime: event.end },
        }),
      }
    );
    if (!res.ok) throw new Error(`Calendar create error ${res.status}`);
  }
}
