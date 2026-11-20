export type CalendarSource = { id: string; name: string; description: string; timeZone: string };
export type CalendarPlan = {
  proposals: string;
  resources: string[];
  start: string;
  end: string;
  stage: boolean;
};
export type CalendarRecord = {
  calendarId: string;
  eventId: string;
  title: string;
  description: string;
  status: string;
  updated: string | null;
  startsAt: string | null;
  endsAt: string | null;
  startDate: string | null;
  endDate: string | null;
  timeZone: string;
  revision: string;
};
export type CalendarWindow = {
  id: string;
  calendarId: string;
  status: "complete" | "unavailable";
  records: CalendarRecord[];
};
export type CalendarReadback = {
  status: "current" | "changed" | "missing" | "unavailable";
  record: CalendarRecord | null;
};
export type CalendarDecision = {
  status: "selected" | "held" | "incomplete" | "stale";
  selection: CalendarRecord | null;
  evidence: CalendarRecord[];
};
export type CalendarHandoff = { path: string; sha256: string };
export type CalendarReport = { decision: CalendarDecision; handoff: CalendarHandoff | null };
