import type { CalendarRecord } from "../../../types.js";
export type RecordAssessment = {
  proposal: CalendarRecord;
  blockers: CalendarRecord[];
  cancellations: CalendarRecord[];
  complete: boolean;
};
