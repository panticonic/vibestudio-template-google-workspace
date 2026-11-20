declare module "natlang:services" {
  export const calendarGoalCatalog: { discover(): Promise<import("./types.js").CalendarSource[]> };
  export const calendarGoalWindows: {
    open(id: string, start: string, end: string): Promise<import("./types.js").CalendarWindow>;
    refresh(windowId: string): Promise<import("./types.js").CalendarWindow>;
  };
  export const calendarGoalReadback: {
    verify(record: import("./types.js").CalendarRecord): Promise<import("./types.js").CalendarReadback>;
  };
  export const calendarGoalHandoff: {
    stage(decision: import("./types.js").CalendarDecision): Promise<import("./types.js").CalendarHandoff>;
  };
}
