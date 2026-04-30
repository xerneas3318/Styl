export interface GmailMessage {
  id:       string;
  subject:  string;
  from:     string;
  snippet:  string;
  date:     string;
}

export class GmailClient {
  constructor(private accessToken: string) {}

  private get auth(): HeadersInit {
    return { Authorization: `Bearer ${this.accessToken}` };
  }

  async getRecentUnread(max = 20): Promise<GmailMessage[]> {
    const res = await fetch(
      `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${max}&q=is:unread`,
      { headers: this.auth }
    );
    if (!res.ok) throw new Error(`Gmail list error ${res.status}`);

    const list = await res.json() as { messages?: Array<{ id: string }> };
    if (!list.messages?.length) return [];

    const results = await Promise.allSettled(
      list.messages.slice(0, max).map((m) => this.fetchMessage(m.id))
    );
    return results
      .filter((r): r is PromiseFulfilledResult<GmailMessage | null> => r.status === 'fulfilled')
      .map((r) => r.value)
      .filter((m): m is GmailMessage => m !== null);
  }

  private async fetchMessage(id: string): Promise<GmailMessage | null> {
    try {
      const res = await fetch(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}` +
        `?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`,
        { headers: this.auth }
      );
      if (!res.ok) return null;

      const data = await res.json() as {
        id: string;
        snippet: string;
        payload: { headers: Array<{ name: string; value: string }> };
      };
      const h = (name: string) =>
        data.payload.headers.find((hh) => hh.name === name)?.value ?? '';

      return { id: data.id, subject: h('Subject'), from: h('From'), snippet: data.snippet, date: h('Date') };
    } catch {
      return null;
    }
  }
}

/** Build a Google OAuth URL for Gmail + Calendar scopes. */
export function buildGoogleOAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id:               'YOUR_GOOGLE_CLIENT_ID',  // replaced at runtime from settings
    redirect_uri:            redirectUri,
    response_type:           'token',
    scope:                   [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/calendar',
    ].join(' '),
    include_granted_scopes:  'true',
  });
  return `https://accounts.google.com/o/oauth2/v2/auth?${params}`;
}
