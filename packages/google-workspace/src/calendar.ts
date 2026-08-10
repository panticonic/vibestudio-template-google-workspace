import { hasRecentPushDelivery } from "./pushState.js";
import {
  createGoogleApiFetcher,
  createGoogleWorkspaceCredentialHandle,
  GoogleApiError,
} from "./google-shared.js";
import type { CredentialClient, UrlCredentialHandle } from "@workspace/runtime/credentials";

const GOOGLE_CALENDAR_BASE_URL = "https://www.googleapis.com/calendar/v3";
const DEFAULT_PUSH_QUIET_WINDOW_MS = 5 * 60_000;

export const manifest = {
  scopes: {
    "google-workspace": ["calendar_readonly", "calendar_events"],
  },
  endpoints: {
    "google-workspace": [
      { url: "https://www.googleapis.com/calendar/v3/calendars/*", methods: ["GET"] },
      {
        url: "https://www.googleapis.com/calendar/v3/calendars/*/events",
        methods: ["GET", "POST"],
      },
      {
        url: "https://www.googleapis.com/calendar/v3/calendars/*/events/*",
        methods: ["GET", "PUT", "DELETE"],
      },
      { url: "https://www.googleapis.com/calendar/v3/users/me/calendarList", methods: ["GET"] },
    ],
  },
  webhooks: {
    "google-workspace": [{ event: "events.changed", deliver: "onEventsChanged" }],
  },
} as const;

export interface CalendarListEntry {
  id: string;
  summary?: string;
  description?: string;
  primary?: boolean;
  accessRole?: string;
  timeZone?: string;
  [key: string]: unknown;
}

export interface CalendarEventDateTime {
  date?: string;
  dateTime?: string;
  timeZone?: string;
}

export interface CalendarEvent {
  id?: string;
  status?: string;
  summary?: string;
  description?: string;
  location?: string;
  updated?: string;
  start?: CalendarEventDateTime;
  end?: CalendarEventDateTime;
  [key: string]: unknown;
}

interface CalendarListResponse {
  items?: CalendarListEntry[];
  nextPageToken?: string;
}

interface EventsListResponse {
  items?: CalendarEvent[];
  nextPageToken?: string;
  nextSyncToken?: string;
}

export interface ListEventsOptions {
  timeMin?: string | Date;
  timeMax?: string | Date;
  syncToken?: string;
  maxResults?: number;
  showDeleted?: boolean;
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
}

export interface ListEventsResult {
  items: CalendarEvent[];
  nextSyncToken?: string;
}

export interface StartPollingOptions {
  calendarId: string;
  syncToken?: string;
  intervalMs?: number;
  standDownWhenPushActive?: boolean;
  pushQuietWindowMs?: number;
  timeMin?: string | Date;
  timeMax?: string | Date;
  maxResults?: number;
  showDeleted?: boolean;
  singleEvents?: boolean;
  orderBy?: "startTime" | "updated";
  onEventChange: (event: CalendarEvent) => void | Promise<void>;
  onError?: (error: Error) => void | Promise<void>;
}

class GoogleCalendarApiError extends GoogleApiError {}

function encodePathSegment(value: string): string {
  return encodeURIComponent(value);
}

function toIsoString(value: string | Date): string {
  return value instanceof Date ? value.toISOString() : value;
}

function buildEventsQuery(options: ListEventsOptions = {}): string {
  if (options.syncToken && (options.timeMin || options.timeMax || options.orderBy)) {
    throw new Error(
      "Google Calendar does not allow timeMin, timeMax, or orderBy when syncToken is set"
    );
  }

  const params = new URLSearchParams();

  if (options.timeMin) {
    params.set("timeMin", toIsoString(options.timeMin));
  }

  if (options.timeMax) {
    params.set("timeMax", toIsoString(options.timeMax));
  }

  if (options.syncToken) {
    params.set("syncToken", options.syncToken);
  }

  if (typeof options.maxResults === "number") {
    params.set("maxResults", String(options.maxResults));
  }

  if (typeof options.showDeleted === "boolean") {
    params.set("showDeleted", String(options.showDeleted));
  }

  if (typeof options.singleEvents === "boolean") {
    params.set("singleEvents", String(options.singleEvents));
  }

  if (options.orderBy) {
    params.set("orderBy", options.orderBy);
  }

  const query = params.toString();
  return query ? `?${query}` : "";
}

export interface CalendarClient {
  handle(): Promise<UrlCredentialHandle>;
  listCalendars(): Promise<CalendarListEntry[]>;
  listEvents(calendarId: string, options?: ListEventsOptions): Promise<ListEventsResult>;
  getEvent(calendarId: string, eventId: string): Promise<CalendarEvent>;
  createEvent(calendarId: string, event: CalendarEvent): Promise<CalendarEvent>;
  updateEvent(calendarId: string, eventId: string, event: CalendarEvent): Promise<CalendarEvent>;
  deleteEvent(calendarId: string, eventId: string): Promise<void>;
  startPolling(options: StartPollingOptions): () => void;
}

/**
 * Build a Google Calendar client bound to the given `CredentialClient`.
 * The credential handle is resolved on first use and memoized.
 */
export function createCalendarClient(credentials: CredentialClient): CalendarClient {
  const handle = createGoogleWorkspaceCredentialHandle(credentials, {
    bindingId: "google-calendar",
  });
  const sharedApiFetch = createGoogleApiFetcher({
    baseUrl: GOOGLE_CALENDAR_BASE_URL,
    serviceName: "Google Calendar",
    handle,
  });
  const apiFetch = async <T>(path: string, init?: RequestInit): Promise<T> => {
    try {
      return await sharedApiFetch<T>(path, init);
    } catch (err) {
      if (err instanceof GoogleApiError) {
        throw new GoogleCalendarApiError("Google Calendar", err.status, err.statusText, err.body);
      }
      throw err;
    }
  };

  const listCalendars = async (): Promise<CalendarListEntry[]> => {
    const calendars: CalendarListEntry[] = [];
    let pageToken: string | undefined;
    do {
      const query = pageToken ? `?${new URLSearchParams({ pageToken }).toString()}` : "";
      const page = await apiFetch<CalendarListResponse>(`/users/me/calendarList${query}`);
      calendars.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
    } while (pageToken);
    return calendars;
  };

  const listEvents = async (
    calendarId: string,
    options: ListEventsOptions = {}
  ): Promise<ListEventsResult> => {
    const events: CalendarEvent[] = [];
    let pageToken: string | undefined;
    let nextSyncToken = options.syncToken;
    do {
      const params = new URLSearchParams(buildEventsQuery(options).slice(1));
      if (pageToken) params.set("pageToken", pageToken);
      const query = params.toString();
      const page = await apiFetch<EventsListResponse>(
        `/calendars/${encodePathSegment(calendarId)}/events${query ? `?${query}` : ""}`
      );
      events.push(...(page.items ?? []));
      pageToken = page.nextPageToken;
      if (page.nextSyncToken) nextSyncToken = page.nextSyncToken;
    } while (pageToken);
    return { items: events, nextSyncToken };
  };

  const startPolling = (options: StartPollingOptions): (() => void) => {
    const intervalMs = options.intervalMs ?? 60_000;
    let active = true;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let syncToken = options.syncToken;

    const scheduleNextPoll = () => {
      if (!active) return;
      timeoutId = setTimeout(() => {
        void poll();
      }, intervalMs);
    };

    const poll = async () => {
      try {
        const auth = await handle();
        if (
          options.standDownWhenPushActive !== false &&
          syncToken &&
          (await hasRecentPushDelivery(
            "google-workspace",
            "events.changed",
            auth.credentialId,
            options.pushQuietWindowMs ?? DEFAULT_PUSH_QUIET_WINDOW_MS
          ))
        ) {
          return;
        }

        const result = await listEvents(
          options.calendarId,
          syncToken
            ? {
                syncToken,
                maxResults: options.maxResults,
                showDeleted: true,
                singleEvents: options.singleEvents,
              }
            : {
                timeMin: options.timeMin,
                timeMax: options.timeMax,
                maxResults: options.maxResults,
                showDeleted: options.showDeleted,
                singleEvents: options.singleEvents,
                orderBy: options.orderBy,
              }
        );

        for (const event of result.items) {
          await options.onEventChange(event);
        }
        if (result.nextSyncToken) syncToken = result.nextSyncToken;
      } catch (error) {
        if (error instanceof GoogleCalendarApiError && error.status === 410) {
          syncToken = undefined;
        } else if (options.onError) {
          await options.onError(error instanceof Error ? error : new Error(String(error)));
        }
      } finally {
        scheduleNextPoll();
      }
    };

    void poll();
    return () => {
      active = false;
      if (timeoutId) clearTimeout(timeoutId);
    };
  };

  return {
    handle,
    listCalendars,
    listEvents,
    getEvent: (calendarId, eventId) =>
      apiFetch<CalendarEvent>(
        `/calendars/${encodePathSegment(calendarId)}/events/${encodePathSegment(eventId)}`
      ),
    createEvent: (calendarId, event) =>
      apiFetch<CalendarEvent>(`/calendars/${encodePathSegment(calendarId)}/events`, {
        method: "POST",
        body: JSON.stringify(event),
      }),
    updateEvent: (calendarId, eventId, event) =>
      apiFetch<CalendarEvent>(
        `/calendars/${encodePathSegment(calendarId)}/events/${encodePathSegment(eventId)}`,
        {
          method: "PUT",
          body: JSON.stringify(event),
        }
      ),
    deleteEvent: async (calendarId, eventId) => {
      await apiFetch<void>(
        `/calendars/${encodePathSegment(calendarId)}/events/${encodePathSegment(eventId)}`,
        { method: "DELETE" }
      );
    },
    startPolling,
  };
}

export async function onEventsChanged(event: unknown): Promise<{
  type: "events.changed";
  connectionId: string;
  resourceId: string | null;
  raw: unknown;
} | void> {
  if (!isWebhookEvent(event)) {
    return;
  }

  return {
    type: "events.changed",
    connectionId: event.connectionId,
    resourceId: event.headers?.["x-goog-resource-id"] ?? null,
    raw: event,
  };
}

function isWebhookEvent(value: unknown): value is {
  connectionId: string;
  headers?: Record<string, string>;
} {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { connectionId?: unknown }).connectionId === "string"
  );
}

export const calendar = {
  manifest,
  createCalendarClient,
  onEventsChanged,
} as const;
