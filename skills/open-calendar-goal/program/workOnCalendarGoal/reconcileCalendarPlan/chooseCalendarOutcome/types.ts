export type RecordAssessment = {
  proposal: CalendarRecord;
  blockers: CalendarRecord[];
  cancellations: CalendarRecord[];
  complete: boolean;
};
