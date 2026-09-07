/**
 * FeedbackFormRenderer Component
 *
 * Renders schema-based feedback forms using FormRenderer.
 * Handles submit/cancel/error callbacks and required field validation.
 * Supports severity and hide submit/cancel options.
 *
 * Custom field types:
 * - toolPreview: Rich previews (Monaco diffs, git previews, etc.) via ToolPreviewField
 * - approvalHeader: Tool approval header (first-time grant or per-call) via ApprovalHeaderField
 */

import { useState, useCallback, useMemo } from "react";
import { Box, Button, Flex, Heading, Text } from "@radix-ui/themes";
import { InfoCircledIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import { FormRenderer, type CustomFieldRendererProps } from "@workspace/react";
import { FREE_TEXT_CHOICE_VALUE, type FieldDefinition, type FieldValue } from "@vibestudio/types";
import type { FeedbackCallbacks } from "../types";
import { ToolPreviewField } from "./ToolPreviewField";
import { ApprovalHeaderField } from "./ApprovalHeaderField";

export interface FeedbackFormRendererProps extends Omit<FeedbackCallbacks, "onError"> {
  title: string;
  fields: FieldDefinition[];
  initialValues?: Record<string, FieldValue>;
  submitLabel?: string;
  cancelLabel?: string;
  severity?: "info" | "warning" | "danger";
  hideSubmit?: boolean;
  hideCancel?: boolean;
  showTitle?: boolean;
}

/**
 * Get the icon for a severity level
 */
function getSeverityIcon(severity: "info" | "warning" | "danger" | undefined) {
  switch (severity) {
    case "danger":
    case "warning":
      return <ExclamationTriangleIcon />;
    default:
      return <InfoCircledIcon />;
  }
}

/**
 * Get the color for a severity level
 */
function getSeverityColor(
  severity: "info" | "warning" | "danger" | undefined
): "blue" | "amber" | "red" {
  switch (severity) {
    case "danger":
      return "red";
    case "warning":
      return "amber";
    default:
      return "blue";
  }
}

function isChoiceField(field: FieldDefinition): boolean {
  return (
    field.type === "select" ||
    field.type === "segmented" ||
    field.type === "multiSelect" ||
    field.type === "buttonGroup"
  );
}

function getsDefaultFreeText(field: FieldDefinition): boolean {
  return field.type === "select" || field.type === "segmented" || field.type === "multiSelect";
}

function getFreeTextKey(field: FieldDefinition): string {
  return field.freeTextKey ?? `${field.key}FreeText`;
}

function withDefaultFreeText(fields: FieldDefinition[]): FieldDefinition[] {
  return fields.map((field) => {
    if (!getsDefaultFreeText(field) || field.allowFreeText !== undefined) {
      return field;
    }
    return { ...field, allowFreeText: true };
  });
}

function hasActiveFreeTextChoice(
  fields: FieldDefinition[],
  values: Record<string, FieldValue>
): boolean {
  return fields.some((field) => {
    if (!isChoiceField(field) || field.allowFreeText !== true) return false;
    const value = values[field.key];
    return Array.isArray(value)
      ? value.includes(FREE_TEXT_CHOICE_VALUE)
      : value === FREE_TEXT_CHOICE_VALUE;
  });
}

function normalizeFreeTextValues(
  fields: FieldDefinition[],
  values: Record<string, FieldValue>
): Record<string, FieldValue> {
  const normalized = { ...values };
  for (const field of fields) {
    if (!isChoiceField(field) || field.allowFreeText !== true) continue;

    const freeTextKey = getFreeTextKey(field);
    const freeText = String(values[freeTextKey] ?? "").trim();
    const value = values[field.key];

    if (Array.isArray(value)) {
      if (value.includes(FREE_TEXT_CHOICE_VALUE)) {
        normalized[field.key] = value.flatMap((item) =>
          item === FREE_TEXT_CHOICE_VALUE ? (freeText ? [freeText] : []) : [item]
        );
      }
    } else if (value === FREE_TEXT_CHOICE_VALUE && freeText) {
      normalized[field.key] = freeText;
    }

    delete normalized[freeTextKey];
  }
  return normalized;
}

export function FeedbackFormRenderer({
  title,
  fields,
  initialValues = {},
  submitLabel = "Save",
  cancelLabel = "Cancel",
  severity,
  hideSubmit = false,
  hideCancel = false,
  showTitle = true,
  onSubmit,
  onCancel,
}: FeedbackFormRendererProps) {
  const effectiveFields = useMemo(() => withDefaultFreeText(fields), [fields]);

  // Initialize state with defaults merged with initial values
  const [values, setValues] = useState<Record<string, FieldValue>>(() => {
    const defaults: Record<string, FieldValue> = {};
    for (const field of effectiveFields) {
      if (field.default !== undefined) {
        defaults[field.key] = field.default;
      }
    }
    return { ...defaults, ...initialValues };
  });
  const [validationError, setValidationError] = useState<string | null>(null);

  const handleChange = useCallback((key: string, value: FieldValue) => {
    setValidationError(null);
    setValues((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSubmit = useCallback(
    (submittedValues?: Record<string, FieldValue>) => {
      const currentValues = submittedValues ?? values;
      // Validate required fields
      for (const field of effectiveFields) {
        if (field.required) {
          const value = currentValues[field.key];
          if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0)) {
            setValidationError(`Required field "${field.label ?? field.key}" is missing`);
            return;
          }
        }
        if (
          isChoiceField(field) &&
          field.allowFreeText === true &&
          hasActiveFreeTextChoice([field], currentValues) &&
          String(currentValues[getFreeTextKey(field)] ?? "").trim() === ""
        ) {
          setValidationError(`Required field "${field.label ?? field.key}" is missing`);
          return;
        }
      }
      setValidationError(null);
      onSubmit(normalizeFreeTextValues(effectiveFields, currentValues));
    },
    [effectiveFields, values, onSubmit]
  );

  // Check if we should show any buttons
  const showSubmit = !hideSubmit || hasActiveFreeTextChoice(effectiveFields, values);
  const showButtons = showSubmit || !hideCancel;

  // Don't show title if we have an approvalHeader field (header contains its own title)
  const hasApprovalHeader = effectiveFields.some((f) => f.type === "approvalHeader");
  const shouldShowTitle = showTitle && !hasApprovalHeader && title;

  // Custom field renderers for toolPreview and approvalHeader fields
  const customFieldRenderers = useMemo(
    () => ({
      toolPreview: ({ field }: CustomFieldRendererProps) => (
        <ToolPreviewField toolName={field.toolName ?? "unknown"} args={field.toolArgs} />
      ),
      approvalHeader: ({ field }: CustomFieldRendererProps) => (
        <ApprovalHeaderField
          agentName={field.agentName ?? "unknown"}
          toolName={field.toolName ?? "unknown"}
          displayName={field.displayName}
          isFirstTimeGrant={field.isFirstTimeGrant ?? false}
          floorLevel={field.floorLevel ?? 1}
        />
      ),
    }),
    []
  );

  return (
    <Box>
      {/* Title with optional severity icon (hidden when approvalHeader is used) */}
      {shouldShowTitle && (
        <Flex align="center" gap="2" mb="4">
          {severity && getSeverityIcon(severity)}
          <Heading size="4">{title}</Heading>
        </Flex>
      )}

      <Flex direction="column" gap="4">
        <FormRenderer
          schema={effectiveFields}
          values={values}
          onChange={handleChange}
          onSubmit={handleSubmit}
          size="2"
          showGroups={true}
          showDescriptions={true}
          showRequiredIndicators={true}
          customFieldRenderers={customFieldRenderers}
          theme="dark"
        />

        {validationError ? (
          <Text color="red" size="2" role="alert">
            {validationError}
          </Text>
        ) : null}

        {showButtons && (
          <Flex gap="3" mt="2" justify="end">
            {!hideCancel && (
              <Button variant="soft" color="gray" onClick={onCancel}>
                {cancelLabel}
              </Button>
            )}
            {showSubmit && (
              <Button
                color={severity ? getSeverityColor(severity) : undefined}
                onClick={() => handleSubmit()}
              >
                {submitLabel}
              </Button>
            )}
          </Flex>
        )}
      </Flex>
    </Box>
  );
}
