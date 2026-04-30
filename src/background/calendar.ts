import type { CalendarEvent } from '../shared/types';

interface GCalEvent {
  id:           string;
  summary:      string;
  start:        { dateTime?: string; date?: string };
  end:          { dateTime?: string; date?: string };
  description?: string;
}

export class CalendarClient {
  constructor(private accessToken: string) {}

  private get auth(): HeadersInit {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  // ── Shared fetch across all user calendars ──────────────────────────────────

  private async fetchAcrossAllCalendars(params: URLSearchParams): Promise<CalendarEvent[]> {
    // 1. Get list of calendars the user has access to
    const listRes = await fetch(
      'https://www.googleapis.com/calendar/v3/users/me/calendarList',
      { headers: this.auth }
    );
    if (!listRes.ok) throw new Error(`Calendar list error ${listRes.status}: ${await listRes.text()}`);
    const listData = await listRes.json() as { items?: Array<{ id: string; accessRole: string }> };
    const calIds   = (listData.items ?? [])
      .filter((c) => c.accessRole === 'owner' || c.accessRole === 'writer' || c.accessRole === 'reader')
      .map((c) => c.id);

    if (!calIds.length) calIds.push('primary');

    // 2. Fetch events from each calendar in parallel
    const results = await Promise.allSettled(
      calIds.map(async (calId) => {
        const res = await fetch(
          `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events?${params}`,
          { headers: this.auth }
        );
        if (!res.ok) return [] as CalendarEvent[];
        const data = await res.json() as { items?: GCalEvent[] };
        return (data.items ?? []).map((e): CalendarEvent => ({
          id:          e.id,
          title:       e.summary ?? '(no title)',
          start:       e.start.dateTime ?? e.start.date ?? '',
          end:         e.end.dateTime   ?? e.end.date   ?? '',
          description: e.description,
        }));
      })
    );

    // 3. Merge, deduplicate by id, sort by start
    const seen = new Set<string>();
    const all: CalendarEvent[] = [];
    for (const r of results) {
      if (r.status === 'fulfilled') {
        for (const e of r.value) {
          if (!seen.has(e.id)) { seen.add(e.id); all.push(e); }
        }
      }
    }
    all.sort((a, b) => a.start.localeCompare(b.start));
    return all;
  }

  // ── Public methods ──────────────────────────────────────────────────────────

  async getUpcomingEvents(daysAhead = 14): Promise<{ events: CalendarEvent[]; warning?: string }> {
    const now = new Date();
    const end = new Date(now); end.setDate(now.getDate() + daysAhead);

    const params = new URLSearchParams({
      timeMin:      now.toISOString(),
      timeMax:      end.toISOString(),
      singleEvents: 'true',
      orderBy:      'startTime',
      maxResults:   '100',
    });

    try {
      const events = await this.fetchAcrossAllCalendars(params);
      return { events };
    } catch (e) {
      return { events: [], warning: (e as Error).message };
    }
  }

  async getEventsForRange(startDate: string, endDate: string): Promise<CalendarEvent[]> {
    const start = new Date(`${startDate}T00:00:00`);
    const end   = new Date(`${endDate}T23:59:59`);

    const params = new URLSearchParams({
      timeMin:      start.toISOString(),
      timeMax:      end.toISOString(),
      singleEvents: 'true',
      orderBy:      'startTime',
      maxResults:   '100',
    });

    return this.fetchAcrossAllCalendars(params);
  }

  async createEvent(event: {
    title:        string;
    start:        string;
    end:          string;
    description?: string;
  }): Promise<void> {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const res = await fetch(
      'https://www.googleapis.com/calendar/v3/calendars/primary/events',
      {
        method:  'POST',
        headers: { ...this.auth, 'Content-Type': 'application/json' },
        body:    JSON.stringify({
          summary:     event.title,
          description: event.description,
          start:       { dateTime: event.start, timeZone: tz },
          end:         { dateTime: event.end,   timeZone: tz },
        }),
      }
    );
    if (!res.ok) throw new Error(`Calendar create error ${res.status}: ${await res.text()}`);
  }

  async deleteEvent(eventId: string): Promise<void> {
    const res = await fetch(
      `https://www.googleapis.com/calendar/v3/calendars/primary/events/${encodeURIComponent(eventId)}`,
      { method: 'DELETE', headers: this.auth }
    );
    // 204 = success, 404 = already gone — both are fine
    if (!res.ok && res.status !== 404) {
      throw new Error(`Calendar delete error ${res.status}: ${await res.text()}`);
    }
  }

  /** @deprecated Use getUpcomingEvents instead */
  async getTodayEvents(): Promise<CalendarEvent[]> {
    const { events } = await this.getUpcomingEvents(1);
    return events;
  }
}
