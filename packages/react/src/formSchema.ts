import type { FieldDefinition, FieldValue, FieldWarning } from "@vibestudio/types";
import {
  evaluateFieldCondition,
  evaluateFieldConditions,
  fieldWarningApplies,
} from "@vibestudio/types";

export const evaluateCondition = evaluateFieldCondition;

export function isFieldVisible(
  field: FieldDefinition,
  values: Record<string, FieldValue>
): boolean {
  return evaluateFieldConditions(field.visibleWhen, values);
}

export function isFieldEnabled(
  field: FieldDefinition,
  values: Record<string, FieldValue>
): boolean {
  return evaluateFieldConditions(field.enabledWhen, values);
}

export function getFieldWarning(
  field: FieldDefinition,
  values: Record<string, FieldValue>
): FieldWarning | null {
  if (!field.warnings) return null;
  for (const warning of field.warnings) {
    if (fieldWarningApplies(field.key, warning, values)) return warning;
  }
  return null;
}

export function groupFields(fields: FieldDefinition[]): Map<string, FieldDefinition[]> {
  const groups = new Map<string, FieldDefinition[]>();
  for (const field of fields) {
    const groupName = field.group ?? "General";
    const group = groups.get(groupName) ?? [];
    group.push(field);
    groups.set(groupName, group);
  }
  for (const group of groups.values()) {
    group.sort((a, b) => (a.order ?? 999) - (b.order ?? 999));
  }
  return groups;
}
