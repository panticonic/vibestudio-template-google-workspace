import { Checkbox, Flex, Select, Text, TextField } from "@radix-ui/themes";
import { jsonSchemaToZod } from "@workspace/pubsub";
import type { JsonSchema } from "@workspace/pubsub";

export interface JsonSchemaFormProps {
  schema: JsonSchema;
  value: Record<string, unknown>;
  onChange: (value: Record<string, unknown>) => void;
  errors?: Record<string, string>;
}

/**
 * Generates form fields from a JSON Schema.
 * Supports: string, number, integer, boolean, enum types.
 */
export function JsonSchemaForm({ schema, value, onChange, errors }: JsonSchemaFormProps) {
  const properties = (schema['properties'] as Record<string, JsonSchema>) ?? {};
  const requiredList = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  const requiredSet = new Set(requiredList);

  const handleFieldChange = (key: string, fieldValue: unknown) => {
    onChange({ ...value, [key]: fieldValue });
  };

  return (
    <Flex direction="column" gap="3">
      {Object.entries(properties).map(([key, propSchema]) => (
        <SchemaField
          key={key}
          name={key}
          schema={propSchema}
          value={value[key]}
          onChange={(v) => handleFieldChange(key, v)}
          required={requiredSet.has(key)}
          error={errors?.[key]}
        />
      ))}
    </Flex>
  );
}

interface SchemaFieldProps {
  name: string;
  schema: JsonSchema;
  value: unknown;
  onChange: (value: unknown) => void;
  required: boolean;
  error?: string;
}

function SchemaField({ name, schema, value, onChange, required, error }: SchemaFieldProps) {
  const description = schema['description'] as string | undefined;
  const enumValues = schema['enum'] as unknown[] | undefined;
  const type = schema['type'] as string | undefined;

  // Handle enum (select dropdown)
  if (enumValues && enumValues.length > 0) {
    const stringValue = value !== undefined ? String(value) : "";
    return (
      <Flex direction="column" gap="1">
        <FieldLabel name={name} required={required} />
        {description && (
          <Text size="1" color="gray">
            {description}
          </Text>
        )}
        <Select.Root value={stringValue} onValueChange={onChange}>
          <Select.Trigger placeholder="Select..." />
          <Select.Content>
            {enumValues.map((opt) => (
              <Select.Item key={String(opt)} value={String(opt)}>
                {String(opt)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select.Root>
        {error && (
          <Text size="1" color="red">
            {error}
          </Text>
        )}
      </Flex>
    );
  }

  // Handle boolean
  if (type === "boolean") {
    return (
      <Flex direction="column" gap="1">
        <Flex align="center" gap="2">
          <Checkbox
            checked={Boolean(value)}
            onCheckedChange={(checked) => onChange(Boolean(checked))}
          />
          <FieldLabel name={name} required={required} inline />
        </Flex>
        {description && (
          <Text size="1" color="gray" style={{ marginLeft: 24 }}>
            {description}
          </Text>
        )}
        {error && (
          <Text size="1" color="red">
            {error}
          </Text>
        )}
      </Flex>
    );
  }

  // Handle number/integer
  if (type === "number" || type === "integer") {
    return (
      <Flex direction="column" gap="1">
        <FieldLabel name={name} required={required} />
        {description && (
          <Text size="1" color="gray">
            {description}
          </Text>
        )}
        <TextField.Root
          type="number"
          placeholder={schema['default'] !== undefined ? `Default: ${schema['default']}` : undefined}
          value={value !== undefined ? String(value) : ""}
          onChange={(e) => {
            const val = e.target.value;
            if (val === "") {
              onChange(undefined);
            } else {
              onChange(type === "integer" ? parseInt(val, 10) : parseFloat(val));
            }
          }}
        />
        {error && (
          <Text size="1" color="red">
            {error}
          </Text>
        )}
      </Flex>
    );
  }

  // Default to string
  return (
    <Flex direction="column" gap="1">
      <FieldLabel name={name} required={required} />
      {description && (
        <Text size="1" color="gray">
          {description}
        </Text>
      )}
      <TextField.Root
        placeholder={schema['default'] !== undefined ? `Default: ${schema['default']}` : undefined}
        value={value !== undefined ? String(value) : ""}
        onChange={(e) => onChange(e.target.value || undefined)}
      />
      {error && (
        <Text size="1" color="red">
          {error}
        </Text>
      )}
    </Flex>
  );
}

interface FieldLabelProps {
  name: string;
  required: boolean;
  inline?: boolean;
}

function FieldLabel({ name, required, inline }: FieldLabelProps) {
  // Convert camelCase/snake_case to Title Case
  const label = name
    .replace(/_/g, " ")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/^./, (s) => s.toUpperCase());

  return (
    <Text size="2" weight="medium" as={inline ? "span" : "label"}>
      {label}
      {required ? (
        <span style={{ color: "var(--red-9)" }}> *</span>
      ) : (
        <span style={{ color: "var(--gray-9)", fontWeight: "normal" }}> (optional)</span>
      )}
    </Text>
  );
}

/**
 * Validates form values against schema using Zod.
 * Returns a map of field names to error messages.
 */
export function validateSchemaForm(
  schema: JsonSchema,
  value: Record<string, unknown>
): Record<string, string> {
  const errors: Record<string, string> = {};

  try {
    const zodSchema = jsonSchemaToZod(schema as Record<string, unknown>);
    const result = zodSchema.safeParse(value);

    if (!result.success) {
      for (const issue of result.error.issues) {
        // Get the field name from the path (first element for top-level fields)
        const fieldName = issue.path[0];
        if (typeof fieldName === "string") {
          // Use the first error for each field
          if (!errors[fieldName]) {
            errors[fieldName] = issue.message;
          }
        }
      }
    }
  } catch {
    // If schema conversion fails, fall back to basic required check
    const requiredList = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
    for (const key of requiredList) {
      const val = value[key];
      if (val === undefined || val === null || val === "") {
        errors[key] = "This field is required";
      }
    }
  }

  return errors;
}

/**
 * Check if a schema has any required parameters.
 */
export function schemaHasRequiredParams(schema: JsonSchema): boolean {
  const requiredList = Array.isArray(schema['required']) ? (schema['required'] as string[]) : [];
  return requiredList.length > 0;
}
