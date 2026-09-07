/**
 * JSON Schema to Zod conversion utilities.
 *
 * Provides functions to convert JSON Schema definitions to Zod schemas,
 * useful for integrating with the Claude Agent SDK and other tools that
 * expect Zod schemas.
 */

import { z } from "zod";

/**
 * Type guard for Record<string, unknown>
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/**
 * Convert a JSON Schema to a Zod schema.
 *
 * Handles common JSON Schema patterns including:
 * - Primitive types (string, number, integer, boolean, null)
 * - Arrays with item schemas
 * - Objects with properties
 * - Enums
 * - Union types (oneOf, anyOf, allOf)
 * - Nullable types
 *
 * @param schema - The JSON Schema object to convert
 * @returns A Zod schema that validates according to the JSON Schema
 */
export function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodTypeAny {
  // Handle enum values first
  const enumValues = schema["enum"];
  if (Array.isArray(enumValues) && enumValues.length > 0) {
    const stringValues = enumValues.filter((v): v is string => typeof v === "string");
    if (stringValues.length === enumValues.length && stringValues.length > 0) {
      return z.enum(stringValues as [string, ...string[]]);
    }
    if (enumValues.length === 1) {
      return z.literal(enumValues[0] as z.Primitive);
    }
    const literals = enumValues.map((v) => z.literal(v as z.Primitive));
    if (literals.length >= 2) {
      return z.union([literals[0]!, literals[1]!, ...literals.slice(2)]);
    }
    return literals[0] ?? z.any();
  }

  const typeValue = schema["type"];

  // Handle union of types (e.g., ["string", "null"])
  if (Array.isArray(typeValue)) {
    const unions = typeValue.map((t) =>
      jsonSchemaToZod({ ...schema, type: t, enum: undefined })
    );
    return unions.length > 1
      ? z.union(unions as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
      : (unions[0] ?? z.any());
  }

  // Handle primitive types
  if (typeValue === "string") {
    return schema["nullable"] === true ? z.string().nullable() : z.string();
  }
  if (typeValue === "number") {
    return schema["nullable"] === true ? z.number().nullable() : z.number();
  }
  if (typeValue === "integer") {
    return schema["nullable"] === true ? z.number().int().nullable() : z.number().int();
  }
  if (typeValue === "boolean") {
    return schema["nullable"] === true ? z.boolean().nullable() : z.boolean();
  }
  if (typeValue === "null") {
    return z.null();
  }

  // Handle arrays
  if (typeValue === "array") {
    const itemsSchema = isRecord(schema["items"])
      ? jsonSchemaToZod(schema["items"])
      : z.any();
    const arraySchema = z.array(itemsSchema);
    return schema["nullable"] === true ? arraySchema.nullable() : arraySchema;
  }

  // Handle objects
  if (typeValue === "object" || isRecord(schema["properties"])) {
    let objectSchema: z.ZodObject<z.ZodRawShape> = z.object(jsonSchemaToZodRawShape(schema));

    // Handle additionalProperties
    const additionalProps = schema["additionalProperties"];
    if (additionalProps === false) {
      // Strict mode: no extra properties allowed
      objectSchema = objectSchema.strict();
    } else if (additionalProps === true || additionalProps === undefined) {
      // Passthrough mode: allow any extra properties (default JSON Schema behavior)
      objectSchema = objectSchema.passthrough();
    } else if (isRecord(additionalProps)) {
      // Typed additional properties: use catchall with the specified schema
      const additionalSchema = jsonSchemaToZod(additionalProps);
      objectSchema = objectSchema.catchall(additionalSchema);
    }

    return schema["nullable"] === true ? objectSchema.nullable() : objectSchema;
  }

  // Handle oneOf
  if (Array.isArray(schema["oneOf"])) {
    const options = (schema["oneOf"] as unknown[]).map((item) =>
      jsonSchemaToZod(isRecord(item) ? item : {})
    );
    const unionSchema =
      options.length > 1
        ? z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
        : (options[0] ?? z.any());
    return schema["nullable"] === true ? unionSchema.nullable() : unionSchema;
  }

  // Handle anyOf
  if (Array.isArray(schema["anyOf"])) {
    const options = (schema["anyOf"] as unknown[]).map((item) =>
      jsonSchemaToZod(isRecord(item) ? item : {})
    );
    const unionSchema =
      options.length > 1
        ? z.union(options as [z.ZodTypeAny, z.ZodTypeAny, ...z.ZodTypeAny[]])
        : (options[0] ?? z.any());
    return schema["nullable"] === true ? unionSchema.nullable() : unionSchema;
  }

  // Handle allOf (intersection)
  if (Array.isArray(schema["allOf"])) {
    const allOfItems = schema["allOf"] as unknown[];
    if (allOfItems.length === 0) {
      return schema["nullable"] === true ? z.any().nullable() : z.any();
    }

    const options = allOfItems.map((item) =>
      jsonSchemaToZod(isRecord(item) ? item : {})
    );

    // Start with the first schema, then intersect with the rest
    // This avoids starting with z.object({}) which would force object type
    let allSchema: z.ZodTypeAny = options[0]!;
    for (let i = 1; i < options.length; i++) {
      allSchema = allSchema.and(options[i]!);
    }

    return schema["nullable"] === true ? allSchema.nullable() : allSchema;
  }

  // Default to any
  return schema["nullable"] === true ? z.any().nullable() : z.any();
}

/**
 * Convert a JSON Schema object to a Zod raw shape for use with z.object().
 *
 * This extracts the properties from a JSON Schema object definition
 * and converts each property to its corresponding Zod type.
 *
 * @param schema - The JSON Schema object to convert
 * @returns A ZodRawShape that can be passed to z.object()
 */
export function jsonSchemaToZodRawShape(schema: Record<string, unknown>): z.ZodRawShape {
  const properties = (schema["properties"] as Record<string, unknown>) ?? {};
  const requiredList = Array.isArray(schema["required"])
    ? (schema["required"] as string[])
    : [];
  const required = new Set(requiredList);

  const shape: z.ZodRawShape = {};
  for (const [key, value] of Object.entries(properties)) {
    const propSchema = isRecord(value) ? value : {};
    const zodProp = jsonSchemaToZod(propSchema);
    shape[key] = required.has(key) ? zodProp : zodProp.optional();
  }
  return shape;
}
