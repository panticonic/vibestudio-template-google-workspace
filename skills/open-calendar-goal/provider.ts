import { sha256HexSyncText } from "@vibestudio/content-addressing";
import { createCalendarClient, type CalendarEvent } from "@workspace/google-workspace/calendar";
import type { CredentialClient } from "@workspace/runtime/credentials";
import type { CalendarRecord, CalendarSource } from "./program/types.js";

export type Event = CalendarEvent & { id: string };
type Page = readonly Event[] | number;
export type Timeline = CalendarSource & {
  initial: readonly Page[];
  refresh?: readonly Page[];
  readback?: Readonly<Record<string, Event | number>>;
};
export type CalendarRequest = {
  method: "catalog" | "window" | "event"; calendarId: string | null; key: string | null;
  generation: number; start: string | null; end: string | null; status: number;
};
const root = "/calendar/v3";
const time = (value: string | undefined) => {
  const millis = value ? Date.parse(value) : NaN;
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
};

export function projectCalendarRecord(source: CalendarSource, event: CalendarEvent): CalendarRecord {
  if (!event.id) throw new Error("Calendar provider record lacks an event identity");
  const data = {
    calendarId: source.id, eventId: event.id, title: event.summary ?? "",
    description: event.description ?? "", status: event.status ?? "confirmed",
    updated: time(event.updated), startsAt: time(event.start?.dateTime), endsAt: time(event.end?.dateTime),
    startDate: event.start?.date ?? null, endDate: event.end?.date ?? null,
    timeZone: event.start?.timeZone ?? source.timeZone,
  };
  return { ...data, revision: sha256HexSyncText(JSON.stringify(data)) };
}

function versioned(page: readonly Page[], id: string) {
  const visible = page.flatMap((item) => typeof item === "number" ? [] : item).filter((event) => event.id === id);
  return visible.reduce<Event | undefined>((latest, item) => {
    if (!latest) return item;
    if (time(item.updated) && (!time(latest.updated) || Date.parse(item.updated!) > Date.parse(latest.updated!)))
      return item;
    return latest;
  }, undefined);
}

export function ownedCalendarProvider(timelines: readonly Timeline[], catalogPageSize: number) {
  const requests: CalendarRequest[] = [];
  const generations = new Map<string, number>();
  let credentialReads = 0;
  let denied = 0;
  const credentials = {
    async forAudience() {
      credentialReads++;
      return {
        credentialId: "owned-calendar-fixture",
        async fetch(input: string | URL, init?: RequestInit) {
          const url = new URL(input);
          if (url.origin !== "https://www.googleapis.com" || (init?.method ?? "GET") !== "GET" ||
              init?.body || new Headers(init?.headers).get("accept") !== "application/json" ||
              requests.length >= 96) {
            denied++;
            throw new Error("The owned Calendar account accepts only bounded provider reads");
          }
          const pageToken = url.searchParams.get("pageToken");
          const index = pageToken === null ? 0 : Number(pageToken.match(/^p([0-9]+)$/u)?.[1]);
          if (!Number.isSafeInteger(index)) throw new Error("Use only provider page tokens");
          const respond = (request: CalendarRequest, value: object | undefined) => {
            requests.push(request);
            return Response.json(value ?? { error: { message: "Calendar observation unavailable" } }, { status: request.status });
          };
          if (url.pathname === root + "/users/me/calendarList") {
            const offset = index * catalogPageSize;
            const items = timelines.slice(offset, offset + catalogPageSize).map(({ id, name, description, timeZone }) =>
              ({ id, summary: name, description, timeZone, accessRole: "reader" }));
            return respond({ method: "catalog", calendarId: null, key: pageToken, generation: 0, start: null, end: null, status: 200 },
              { items, ...(offset + catalogPageSize < timelines.length ? { nextPageToken: "p" + (index + 1) } : {}) });
          }
          const coordinates = url.pathname.split("/");
          const encodedId = coordinates[4];
          const encodedEvent = coordinates[6];
          const calendar = coordinates.slice(0, 4).join("/") === root + "/calendars" &&
            coordinates[5] === "events" && coordinates.length <= 7 && encodedId &&
            timelines.find(({ id }) => id === decodeURIComponent(encodedId));
          if (!calendar) throw new Error("The calendar is outside this owned account");
          const start = url.searchParams.get("timeMin");
          const end = url.searchParams.get("timeMax");
          if (encodedEvent) {
            const eventId = decodeURIComponent(encodedEvent);
            const generation = generations.get(calendar.id) ?? 0;
            const current = calendar.readback?.[eventId] ??
              versioned(generation > 1 ? calendar.refresh ?? calendar.initial : calendar.initial, eventId);
            const status = typeof current === "number" ? current : current ? 200 : 404;
            return respond({ method: "event", calendarId: calendar.id, key: eventId, generation,
              start: null, end: null, status }, typeof current === "object" ? current : undefined);
          }
          if (!start || !end || !time(start) || !time(end) || url.searchParams.get("showDeleted") !== "true" ||
              url.searchParams.get("singleEvents") !== "true")
            throw new Error("Open an authorized interval including cancellation and instance evidence");
          if (index === 0) generations.set(calendar.id, (generations.get(calendar.id) ?? 0) + 1);
          const generation = generations.get(calendar.id) ?? 0;
          const pages = generation > 1 ? calendar.refresh ?? calendar.initial : calendar.initial;
          const contents = pages[index];
          if (!contents) throw new Error("Provider page lies outside the bounded calendar window");
          const status = typeof contents === "number" ? contents : 200;
          const items = typeof contents === "number" ? undefined : contents.filter((event) => (
            event.status === "cancelled" || !event.start?.dateTime || !event.end?.dateTime ||
            (Date.parse(event.start.dateTime) < Date.parse(end) && Date.parse(event.end.dateTime) > Date.parse(start))
          ));
          return respond({ method: "window", calendarId: calendar.id, key: pageToken, generation,
            start, end, status }, items && {
              items, ...(index + 1 < pages.length ? { nextPageToken: "p" + (index + 1) } : {}),
            });
        },
      };
    },
  } as unknown as CredentialClient;
  return {
    client: createCalendarClient(credentials),
    trace() {
      return { requests: structuredClone(requests), credentialReads, denied };
    },
  };
}
