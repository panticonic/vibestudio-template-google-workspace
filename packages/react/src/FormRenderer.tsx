/**
 * FormRenderer Component
 *
 * Renders data-driven forms from field definitions.
 * Supports conditionality, notched sliders, and multiple field types.
 */

import {
  Button,
  Callout,
  Card,
  Checkbox,
  CheckboxGroup,
  Code,
  Flex,
  RadioGroup,
  ScrollArea,
  SegmentedControl,
  Select,
  Slider,
  Switch,
  Text,
  TextArea,
  TextField,
} from "@radix-ui/themes";
import { InfoCircledIcon, ExclamationTriangleIcon } from "@radix-ui/react-icons";
import type { FieldDefinition, FieldValue, FieldWarning, FormSchema } from "@vibestudio/types";
import { FREE_TEXT_CHOICE_VALUE } from "@vibestudio/types";
import { isFieldVisible, isFieldEnabled, getFieldWarning, groupFields } from "./formSchema.js";
/**
 * Format slider value for display based on field definition hints.
 * Supports notched sliders, temperature-like decimals, and token counts.
 */
export function formatSliderValue(value: number, field: FieldDefinition): string {
  // If we have notches, find the matching notch label
  if (field.notches) {
    const notch = field.notches.find((n) => n.value === value);
    if (notch) return notch.label;
  }

  // Temperature-like slider (decimal step)
  if (field.step !== undefined && field.step < 1) {
    return value.toFixed(1);
  }

  // Token counts or large numbers
  if (field.max !== undefined && field.max >= 1000) {
    if (value === 0 && field.sliderLabels?.min === "Off") {
      return "Disabled";
    }
    return `${value.toLocaleString()} tokens`;
  }

  return String(value);
}

/**
 * Get the icon for a warning severity
 */
function getWarningIcon(severity: FieldWarning["severity"]) {
  switch (severity) {
    case "danger":
      return <ExclamationTriangleIcon />;
    case "warning":
      return <ExclamationTriangleIcon />;
    default:
      return <InfoCircledIcon />;
  }
}

/**
 * Get the color for a warning severity
 */
function getWarningColor(severity: FieldWarning["severity"]): "red" | "orange" | "blue" {
  switch (severity) {
    case "danger":
      return "red";
    case "warning":
      return "orange";
    default:
      return "blue";
  }
}

function fieldSupportsFreeText(field: FieldDefinition): boolean {
  return (
    field.allowFreeText === true &&
    (field.type === "select" ||
      field.type === "segmented" ||
      field.type === "multiSelect" ||
      field.type === "buttonGroup")
  );
}

function getFreeTextKey(field: FieldDefinition): string {
  return field.freeTextKey ?? `${field.key}FreeText`;
}

function getOptionsWithFreeText(field: FieldDefinition) {
  const options = field.options ?? [];
  if (
    !fieldSupportsFreeText(field) ||
    options.some((option) => option.value === FREE_TEXT_CHOICE_VALUE)
  ) {
    return options;
  }
  return [
    ...options,
    {
      value: FREE_TEXT_CHOICE_VALUE,
      label: field.freeTextLabel ?? "Other",
      description: "Enter your own answer.",
    },
  ];
}

function isFreeTextSelected(field: FieldDefinition, value: FieldValue | undefined): boolean {
  if (!fieldSupportsFreeText(field)) return false;
  if (Array.isArray(value)) return value.includes(FREE_TEXT_CHOICE_VALUE);
  return value === FREE_TEXT_CHOICE_VALUE;
}

function getMultiSelectBulkValues(field: FieldDefinition): string[] {
  return getOptionsWithFreeText(field)
    .map((option) => option.value)
    .filter((value) => value !== FREE_TEXT_CHOICE_VALUE);
}

/**
 * Props for custom field renderer components.
 * Used with customFieldRenderers to handle custom field types like toolPreview.
 */
export interface CustomFieldRendererProps {
  field: FieldDefinition;
  value: FieldValue;
  theme?: "light" | "dark";
}

export interface FormRendererProps {
  /** Field definitions or full form schema */
  schema: FormSchema | FieldDefinition[];
  /** Current values for each field */
  values: Record<string, FieldValue>;
  /** Callback when a value changes */
  onChange: (key: string, value: FieldValue) => void;
  /**
   * Optional callback for form submission (used by buttonGroup with submitOnSelect)
   */
  onSubmit?: (values?: Record<string, FieldValue>) => void;
  /**
   * Size of form controls
   * @default "2"
   */
  size?: "1" | "2" | "3";
  /**
   * Whether to group fields by their `group` property
   * @default true
   */
  showGroups?: boolean;
  /**
   * Whether to show field descriptions
   * @default true
   */
  showDescriptions?: boolean;
  /**
   * Whether to show required/optional indicators
   * @default false
   */
  showRequiredIndicators?: boolean;
  /**
   * Whether to stop click propagation on inputs
   * @default false
   */
  stopPropagation?: boolean;
  /**
   * Custom field renderers for handling additional field types.
   * Keys are field type names (e.g., "toolPreview"), values are React components.
   * This allows injecting custom rendering without circular dependencies.
   */
  customFieldRenderers?: Record<string, React.ComponentType<CustomFieldRendererProps>>;
  /**
   * Theme for custom field renderers
   * @default "dark"
   */
  theme?: "light" | "dark";
}

/**
 * Renders a data-driven form from field definitions.
 */
export function FormRenderer({
  schema,
  values,
  onChange,
  onSubmit,
  size = "2",
  showGroups = true,
  showDescriptions = true,
  showRequiredIndicators = false,
  stopPropagation = false,
  customFieldRenderers,
  theme = "dark",
}: FormRendererProps) {
  const fields = Array.isArray(schema) ? schema : schema.fields;
  const groups = showGroups ? groupFields(fields) : null;

  // Build effective values by merging provided values with field defaults
  // This ensures visibility/enabled conditions work correctly even when
  // the controlling field only has a default value
  const effectiveValues: Record<string, FieldValue> = {};
  for (const field of fields) {
    const value = values[field.key];
    if (value !== undefined) {
      effectiveValues[field.key] = value;
    } else if (field.default !== undefined) {
      effectiveValues[field.key] = field.default;
    }
  }

  // Handle click propagation
  const clickProps = stopPropagation
    ? { onClick: (e: React.MouseEvent) => e.stopPropagation() }
    : {};

  const renderField = (field: FieldDefinition) => {
    // Check visibility using effective values (includes defaults)
    if (!isFieldVisible(field, effectiveValues)) {
      return null;
    }

    const isEnabled = isFieldEnabled(field, effectiveValues);
    const currentValue = effectiveValues[field.key] ?? field.default;
    const warning = getFieldWarning(field, effectiveValues);
    const freeTextKey = getFreeTextKey(field);
    const freeTextValue = values[freeTextKey] ?? effectiveValues[freeTextKey];
    const showFreeText = isFreeTextSelected(field, currentValue as FieldValue | undefined);
    const freeTextInput = showFreeText ? (
      <TextArea
        size={size}
        placeholder={field.freeTextPlaceholder ?? "Type your answer..."}
        value={String(freeTextValue ?? "")}
        disabled={!isEnabled}
        onChange={(e) => onChange(freeTextKey, e.target.value)}
        {...clickProps}
      />
    ) : null;
    const submitOnSelect = (value: string) => {
      if (field.submitOnSelect && onSubmit && value !== FREE_TEXT_CHOICE_VALUE) {
        onSubmit({ ...effectiveValues, [field.key]: value });
      }
    };
    const renderMultiSelectBulkActions = (selected: string[]) => {
      const bulkValues = getMultiSelectBulkValues(field);
      if (bulkValues.length < 2) return null;

      const bulkValueSet = new Set(bulkValues);
      const allSelected = bulkValues.every((value) => selected.includes(value));
      const hasSelection = selected.length > 0;

      return (
        <Flex gap="2" wrap="wrap">
          <Button
            size="1"
            variant="soft"
            color="gray"
            disabled={!isEnabled || allSelected}
            onClick={() => {
              const preserved = selected.filter((value) => !bulkValueSet.has(value));
              onChange(field.key, [...preserved, ...bulkValues]);
            }}
          >
            Select all
          </Button>
          <Button
            size="1"
            variant="soft"
            color="gray"
            disabled={!isEnabled || !hasSelection}
            onClick={() => onChange(field.key, [])}
          >
            Deselect all
          </Button>
        </Flex>
      );
    };

    // Build placeholder text with default value info
    const placeholderText = field.placeholder
      ? field.default !== undefined
        ? `${field.placeholder} (default: ${field.default})`
        : field.placeholder
      : field.default !== undefined
        ? `Default: ${field.default}`
        : undefined;

    return (
      <Flex key={field.key} direction="column" gap="1" style={{ opacity: isEnabled ? 1 : 0.5 }}>
        {/* Only show label if non-empty (custom field types may have built-in headers) */}
        {field.label && (
          <Text size={size} weight="medium">
            {field.label}
            {showRequiredIndicators &&
              (field.required ? (
                <span style={{ color: "var(--red-9)" }}> *</span>
              ) : (
                <span style={{ color: "var(--gray-9)", fontWeight: "normal" }}> (optional)</span>
              ))}
          </Text>
        )}
        {showDescriptions && field.description && (
          <Text size="1" color="gray">
            {field.description}
          </Text>
        )}

        {/* Custom field renderer (if provided) */}
        {customFieldRenderers?.[field.type] &&
          (() => {
            const CustomRenderer = customFieldRenderers[field.type]!;
            return (
              <CustomRenderer field={field} value={currentValue as FieldValue} theme={theme} />
            );
          })()}

        {/* String input */}
        {field.type === "string" && (
          <TextField.Root
            size={size}
            placeholder={placeholderText}
            value={String(currentValue ?? "")}
            disabled={!isEnabled}
            onChange={(e) => onChange(field.key, e.target.value)}
            {...clickProps}
          />
        )}

        {field.type === "textarea" && (
          <TextArea
            size={size}
            placeholder={placeholderText}
            value={String(currentValue ?? "")}
            disabled={!isEnabled}
            onChange={(e) => onChange(field.key, e.target.value)}
            style={{
              minHeight: field.maxHeight ? Math.min(field.maxHeight, 240) : 120,
              maxHeight: field.maxHeight,
            }}
            {...clickProps}
          />
        )}

        {/* Number input */}
        {field.type === "number" && (
          <TextField.Root
            size={size}
            type="number"
            placeholder={placeholderText}
            value={String(currentValue ?? "")}
            disabled={!isEnabled}
            onChange={(e) =>
              onChange(field.key, e.target.value === "" ? "" : Number(e.target.value))
            }
            {...clickProps}
          />
        )}

        {/* Boolean switch */}
        {field.type === "boolean" && (
          <Switch
            size={size}
            checked={Boolean(currentValue)}
            disabled={!isEnabled}
            onCheckedChange={(checked) => onChange(field.key, checked)}
            {...clickProps}
          />
        )}

        {/* Select dropdown */}
        {field.type === "select" && field.options && (
          <Flex direction="column" gap="2" {...clickProps}>
            <Select.Root
              size={size}
              value={String(currentValue ?? "")}
              disabled={!isEnabled}
              onValueChange={(value) => {
                onChange(field.key, value);
                submitOnSelect(value);
              }}
            >
              <Select.Trigger placeholder="Select..." />
              <Select.Content>
                {getOptionsWithFreeText(field).map((option) => (
                  <Select.Item key={option.value} value={option.value}>
                    {option.label}
                  </Select.Item>
                ))}
              </Select.Content>
            </Select.Root>
            {freeTextInput}
          </Flex>
        )}

        {/* Slider (continuous or notched) */}
        {field.type === "slider" && (
          <Flex direction="column" gap="1" style={{ maxWidth: 300 }} {...clickProps}>
            <Flex justify="between" align="center">
              <Text size="1" color="gray">
                {formatSliderValue(Number(currentValue ?? field.min ?? 0), field)}
              </Text>
            </Flex>
            <Slider
              size={size}
              value={[Number(currentValue ?? field.min ?? 0)]}
              disabled={!isEnabled}
              onValueChange={(vals) => onChange(field.key, vals[0] ?? 0)}
              min={field.min ?? 0}
              max={field.max ?? 100}
              step={field.step ?? 1}
            />
            {/* Notch labels */}
            {field.notches && field.notches.length > 0 ? (
              <Flex justify="between" style={{ paddingLeft: 2, paddingRight: 2 }}>
                {field.notches.map((notch) => (
                  <Text
                    key={notch.value}
                    size="1"
                    color={Number(currentValue) === notch.value ? undefined : "gray"}
                    weight={Number(currentValue) === notch.value ? "medium" : undefined}
                  >
                    {notch.label}
                  </Text>
                ))}
              </Flex>
            ) : field.sliderLabels ? (
              <Flex justify="between">
                <Text size="1" color="gray">
                  {field.sliderLabels.min}
                </Text>
                <Text size="1" color="gray">
                  {field.sliderLabels.max}
                </Text>
              </Flex>
            ) : null}
            {/* Notch description */}
            {field.notches &&
              (() => {
                const notch = field.notches.find((n) => n.value === Number(currentValue));
                return notch?.description ? (
                  <Text size="1" color="gray">
                    {notch.description}
                  </Text>
                ) : null;
              })()}
          </Flex>
        )}

        {/* Segmented control - buttons variant (default) */}
        {field.type === "segmented" && field.options && field.variant !== "cards" && (
          <Flex direction="column" gap="1" style={{ maxWidth: 400 }} {...clickProps}>
            <SegmentedControl.Root
              size={size}
              value={String(currentValue ?? "")}
              onValueChange={
                isEnabled
                  ? (value) => {
                      onChange(field.key, value);
                      submitOnSelect(value);
                    }
                  : undefined
              }
            >
              {getOptionsWithFreeText(field).map((option) => (
                <SegmentedControl.Item key={option.value} value={option.value}>
                  {option.label}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
            {/* Selected option description */}
            {(() => {
              const selectedOption = getOptionsWithFreeText(field).find(
                (o) => o.value === String(currentValue)
              );
              return selectedOption?.description ? (
                <Text size="1" color="gray">
                  {selectedOption.description}
                </Text>
              ) : null;
            })()}
            {freeTextInput}
          </Flex>
        )}

        {/* Segmented control - cards variant */}
        {field.type === "segmented" && field.options && field.variant === "cards" && (
          <Flex direction="column" gap="2" {...clickProps}>
            <RadioGroup.Root
              size={size}
              value={String(currentValue ?? "")}
              onValueChange={
                isEnabled
                  ? (value) => {
                      onChange(field.key, value);
                      submitOnSelect(value);
                    }
                  : undefined
              }
            >
              <Flex direction="column" gap="2">
                {getOptionsWithFreeText(field).map((option) => {
                  const selected = String(currentValue ?? "") === option.value;
                  return (
                    <Card
                      key={option.value}
                      size="1"
                      asChild
                      data-surface-tone={selected ? "selected" : undefined}
                      style={{
                        opacity: isEnabled ? 1 : 0.6,
                      }}
                    >
                      <label style={{ cursor: isEnabled ? "pointer" : "default" }}>
                        <Flex gap="2" align={option.description ? "start" : "center"}>
                          <RadioGroup.Item
                            value={option.value}
                            disabled={!isEnabled}
                            style={{
                              position: "absolute",
                              opacity: 0,
                              pointerEvents: "none",
                            }}
                          />
                          <Flex direction="column" gap="1">
                            <Text weight="medium">{option.label}</Text>
                            {option.description && (
                              <Text size="1" color="gray">
                                {option.description}
                              </Text>
                            )}
                          </Flex>
                        </Flex>
                      </label>
                    </Card>
                  );
                })}
              </Flex>
            </RadioGroup.Root>
            {freeTextInput}
          </Flex>
        )}

        {/* Toggle (two-state with labels) */}
        {field.type === "toggle" && field.options && field.options.length >= 2 && (
          <Flex direction="column" gap="1" style={{ maxWidth: 200 }} {...clickProps}>
            <SegmentedControl.Root
              size={size}
              value={String(currentValue ?? field.options[0]!.value)}
              onValueChange={
                isEnabled
                  ? (value) => {
                      onChange(field.key, value);
                      submitOnSelect(value);
                    }
                  : undefined
              }
            >
              {field.options.slice(0, 2).map((option) => (
                <SegmentedControl.Item key={option.value} value={option.value}>
                  {option.label}
                </SegmentedControl.Item>
              ))}
            </SegmentedControl.Root>
            {/* Selected option description */}
            {(() => {
              const selectedOption = getOptionsWithFreeText(field).find(
                (o) => o.value === String(currentValue)
              );
              return selectedOption?.description ? (
                <Text size="1" color="gray">
                  {selectedOption.description}
                </Text>
              ) : null;
            })()}
            {freeTextInput}
          </Flex>
        )}

        {/* Readonly field - display-only text */}
        {field.type === "readonly" && (
          <Text size={size} color="gray">
            {String(currentValue ?? "")}
          </Text>
        )}

        {/* Code field - syntax-highlighted code block */}
        {field.type === "code" && (
          <ScrollArea style={{ maxHeight: field.maxHeight ?? 200 }} {...clickProps}>
            <Code variant="soft" size="1" style={{ whiteSpace: "pre-wrap", display: "block" }}>
              {String(currentValue ?? "")}
            </Code>
          </ScrollArea>
        )}

        {/* ButtonGroup field - horizontal action buttons */}
        {field.type === "buttonGroup" && field.buttons && (
          <Flex direction="column" gap="2" {...clickProps}>
            <Flex gap="2">
              {[
                ...field.buttons,
                ...(fieldSupportsFreeText(field)
                  ? [
                      {
                        value: FREE_TEXT_CHOICE_VALUE,
                        label: field.freeTextLabel ?? "Other",
                        color: "gray" as const,
                      },
                    ]
                  : []),
              ].map((btn) => (
                <Button
                  key={btn.value}
                  variant={field.buttonStyle ?? "outline"}
                  color={btn.color ?? "gray"}
                  disabled={!isEnabled}
                  onClick={() => {
                    onChange(field.key, btn.value);
                    if (field.submitOnSelect && onSubmit && btn.value !== FREE_TEXT_CHOICE_VALUE) {
                      onSubmit({ ...effectiveValues, [field.key]: btn.value });
                    }
                  }}
                >
                  {btn.label}
                </Button>
              ))}
            </Flex>
            {freeTextInput}
          </Flex>
        )}

        {/* MultiSelect field - list variant (default) */}
        {field.type === "multiSelect" && field.options && field.variant !== "cards" && (
          <Flex direction="column" gap="1" {...clickProps}>
            {(() => {
              const selected = Array.isArray(currentValue) ? currentValue : [];
              return renderMultiSelectBulkActions(selected);
            })()}
            {getOptionsWithFreeText(field).map((opt) => {
              const selected = Array.isArray(currentValue) ? currentValue : [];
              const isChecked = selected.includes(opt.value);
              return (
                <Flex key={opt.value} gap="2" align="center">
                  <Checkbox
                    checked={isChecked}
                    disabled={!isEnabled}
                    onCheckedChange={(checked) => {
                      const next = checked
                        ? [...selected, opt.value]
                        : selected.filter((v) => v !== opt.value);
                      onChange(field.key, next);
                    }}
                  />
                  <Text size={size}>{opt.label}</Text>
                  {opt.description && (
                    <Text size="1" color="gray">
                      {opt.description}
                    </Text>
                  )}
                </Flex>
              );
            })}
            {freeTextInput}
          </Flex>
        )}

        {/* MultiSelect field - cards variant (CheckboxGroup with visible checkboxes) */}
        {field.type === "multiSelect" && field.options && field.variant === "cards" && (
          <Flex direction="column" gap="2" {...clickProps}>
            {renderMultiSelectBulkActions(Array.isArray(currentValue) ? currentValue : [])}
            <CheckboxGroup.Root
              size={size}
              value={Array.isArray(currentValue) ? currentValue : []}
              onValueChange={isEnabled ? (value) => onChange(field.key, value) : undefined}
            >
              <Flex direction="column" gap="2">
                {getOptionsWithFreeText(field).map((opt) => (
                  <Text as="label" size={size} key={opt.value}>
                    <Flex gap="2" align={opt.description ? "start" : "center"}>
                      <CheckboxGroup.Item
                        value={opt.value}
                        disabled={!isEnabled}
                        style={{ marginTop: opt.description ? 2 : 0 }}
                      />
                      <Flex direction="column" gap="1">
                        <Text weight="medium">{opt.label}</Text>
                        {opt.description && (
                          <Text size="1" color="gray">
                            {opt.description}
                          </Text>
                        )}
                      </Flex>
                    </Flex>
                  </Text>
                ))}
              </Flex>
            </CheckboxGroup.Root>
            {freeTextInput}
          </Flex>
        )}

        {/* Diff field - pre-formatted diff display */}
        {field.type === "diff" && (
          <ScrollArea style={{ maxHeight: field.maxHeight ?? 300 }} {...clickProps}>
            <Code variant="soft" size="1" style={{ whiteSpace: "pre", display: "block" }}>
              {String(currentValue ?? "")}
            </Code>
          </ScrollArea>
        )}

        {/* Warning callout */}
        {warning && (
          <Callout.Root color={getWarningColor(warning.severity)} size="1">
            <Callout.Icon>{getWarningIcon(warning.severity)}</Callout.Icon>
            <Callout.Text>{warning.message}</Callout.Text>
          </Callout.Root>
        )}
      </Flex>
    );
  };

  // Render with grouping
  if (groups) {
    return (
      <Flex direction="column" gap="4">
        {Array.from(groups.entries()).map(([groupName, groupFields]) => {
          // Filter visible fields using effective values
          const visibleFields = groupFields.filter((f) => isFieldVisible(f, effectiveValues));
          if (visibleFields.length === 0) return null;

          return (
            <Flex key={groupName} direction="column" gap="3">
              <Text
                size="1"
                color="gray"
                weight="medium"
                style={{ textTransform: "uppercase", letterSpacing: "0.05em" }}
              >
                {groupName}
              </Text>
              {visibleFields.map(renderField)}
            </Flex>
          );
        })}
      </Flex>
    );
  }

  // Render flat (no grouping)
  return (
    <Flex direction="column" gap="2">
      {fields.map(renderField)}
    </Flex>
  );
}
