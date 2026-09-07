export interface ExactInspectionPin {
  url: string;
  credential?: string;
  ref: string;
  commit: string;
  snapshot: string;
}

export function retainedInspectionPin(locator: unknown): ExactInspectionPin | null {
  if (typeof locator !== "object" || locator === null || !("pin" in locator)) return null;
  return (locator as { pin: ExactInspectionPin }).pin;
}
