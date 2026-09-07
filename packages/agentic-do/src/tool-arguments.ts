import { Validator, type Schema } from "@cfworker/json-schema";
import { Kind } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { AgentTool } from "@workspace/pi-core";
import { draft7MetaSchema } from "@workspace/pubsub";

const validators = new WeakMap<object, Validator>();
const validSchemas = new WeakSet<object>();
const schemaValidator = new Validator(draft7MetaSchema, "7", false);

/** Fail before provider dispatch when a local tool advertises malformed JSON
 * Schema. Execution-time argument validation is too late: strict providers
 * reject the entire tool roster before the model can produce a call. */
export function assertAgentToolParametersSchema(toolName: string, parameters: unknown): void {
  if (!isRecord(parameters)) {
    throw new Error(`Tool ${toolName} parameters must be a JSON Schema object`);
  }
  if (validSchemas.has(parameters)) return;
  const validation = schemaValidator.validate(parameters);
  if (!validation.valid) {
    const detail = validation.errors
      .slice(0, 3)
      .map((error) => `${error.instanceLocation || "schema"}: ${error.error}`)
      .join("; ");
    throw new Error(`Tool ${toolName} advertises invalid JSON Schema: ${detail}`);
  }
  validSchemas.add(parameters);
}

/** Enforce the tool's advertised schema at the durable execution boundary.
 * Model providers may emit malformed tool calls; no local tool may rely on
 * provider-side validation for safety. */
export function prepareAgentToolArguments(tool: AgentTool, raw: unknown): unknown {
  assertAgentToolParametersSchema(tool.name, tool.parameters);
  const mismatch = findDiscriminatorMismatch(tool.parameters, raw);
  if (mismatch) {
    throw invalidToolArguments(
      tool.name,
      `${mismatch.path}: Expected one of ${mismatch.expected.map((value) => JSON.stringify(value)).join(", ")}; received ${JSON.stringify(mismatch.actual)}`
    );
  }
  if (Kind in tool.parameters) {
    const selectedErrors = findSelectedUnionErrors(tool.parameters, raw);
    if (selectedErrors.length > 0) {
      throw invalidToolArguments(tool.name, selectedErrors.slice(0, 3).join("; "));
    }
    const schema = specializeDiscriminatedUnions(tool.parameters, raw);
    const errors = [...Value.Errors(schema as never, raw)].slice(0, 3);
    if (errors.length === 0) return raw;
    const detail = errors.map((error) => `${error.path || "/"}: ${error.message}`).join("; ");
    throw invalidToolArguments(tool.name, detail);
  }
  let validator = validators.get(tool.parameters);
  if (!validator) {
    validator = new Validator(tool.parameters as Schema, "7", false);
    validators.set(tool.parameters, validator);
  }
  const validation = validator.validate(raw);
  if (validation.valid) return raw;
  const detail = validation.errors
    .slice(0, 3)
    .map((error) => `${error.instanceLocation || "#"}: ${error.error}`)
    .join("; ");
  throw invalidToolArguments(tool.name, detail);
}

function invalidToolArguments(toolName: string, detail: string): Error & { code: string } {
  return Object.assign(new Error(`Invalid arguments for tool ${toolName}: ${detail}`), {
    code: "invalid_tool_arguments",
  });
}

function findDiscriminatorMismatch(
  schema: unknown,
  value: unknown,
  path = ""
): { path: string; expected: unknown[]; actual: unknown } | null {
  if (!isRecord(schema)) return null;
  const alternatives = Array.isArray(schema["anyOf"]) ? schema["anyOf"] : null;
  if (alternatives && isRecord(value)) {
    const discriminators = new Map<string, unknown[]>();
    for (const candidate of alternatives) {
      for (const [key, property] of requiredLiteralDiscriminators(candidate)) {
        const values = discriminators.get(key) ?? [];
        if (!values.includes(property["const"])) values.push(property["const"]);
        discriminators.set(key, values);
      }
    }
    for (const [key, expected] of discriminators) {
      if (expected.length < 2 || !Object.hasOwn(value, key) || expected.includes(value[key]))
        continue;
      return { path: `${path}/${key}`, expected, actual: value[key] };
    }
    const matching = alternatives.filter((candidate) => branchMatches(candidate, value));
    if (matching.length === 1) return findDiscriminatorMismatch(matching[0], value, path);
  }
  const properties = isRecord(schema["properties"]) ? schema["properties"] : null;
  if (properties && isRecord(value)) {
    for (const [key, child] of Object.entries(properties)) {
      const mismatch = findDiscriminatorMismatch(child, value[key], `${path}/${key}`);
      if (mismatch) return mismatch;
    }
  }
  if (isRecord(schema["items"]) && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const mismatch = findDiscriminatorMismatch(schema["items"], item, `${path}/${index}`);
      if (mismatch) return mismatch;
    }
  }
  return null;
}

/** Validate the exact union branch selected inside nested objects and arrays
 * before TypeBox formats the enclosing schema. Without this pass, an invalid
 * array element is reported against the union's first branch even when its
 * literal discriminator selected a later branch unambiguously. */
function findSelectedUnionErrors(schema: unknown, value: unknown, path = ""): string[] {
  if (!isRecord(schema)) return [];
  const alternatives = Array.isArray(schema["anyOf"]) ? schema["anyOf"] : null;
  if (alternatives && isRecord(value)) {
    const matching = alternatives.filter((candidate) => branchMatches(candidate, value));
    if (matching.length === 1) {
      const selected = matching[0];
      const nested = findSelectedUnionErrors(selected, value, path);
      if (nested.length > 0) return nested;
      return [...Value.Errors(selected as never, value)].map(
        (error) => `${path}${error.path || "/"}: ${error.message}`
      );
    }
  }
  const properties = isRecord(schema["properties"]) ? schema["properties"] : null;
  if (properties && isRecord(value)) {
    for (const [key, child] of Object.entries(properties)) {
      const errors = findSelectedUnionErrors(child, value[key], `${path}/${key}`);
      if (errors.length > 0) return errors;
    }
  }
  if (isRecord(schema["items"]) && Array.isArray(value)) {
    for (const [index, item] of value.entries()) {
      const errors = findSelectedUnionErrors(schema["items"], item, `${path}/${index}`);
      if (errors.length > 0) return errors;
    }
  }
  return [];
}

/** Select the schema branch named by literal discriminator fields before
 * formatting validation failures. TypeBox correctly rejects a bad union, but
 * its exhaustive branch errors otherwise lead with an unrelated first branch
 * (for example `status` when an `integrate` request is missing evidence). */
function specializeDiscriminatedUnions(schema: unknown, value: unknown): unknown {
  if (!isRecord(schema)) return schema;
  const alternatives = Array.isArray(schema["anyOf"]) ? schema["anyOf"] : null;
  if (alternatives && isRecord(value)) {
    const matching = alternatives.filter((candidate) => branchMatches(candidate, value));
    if (matching.length === 1) return specializeDiscriminatedUnions(matching[0], value);
  }
  const properties = isRecord(schema["properties"]) ? schema["properties"] : null;
  if (!properties || !isRecord(value)) return schema;
  return {
    ...schema,
    properties: Object.fromEntries(
      Object.entries(properties).map(([key, child]) => [
        key,
        specializeDiscriminatedUnions(child, value[key]),
      ])
    ),
  };
}

function branchMatches(candidate: unknown, value: Record<string, unknown>): boolean {
  const discriminators = requiredLiteralDiscriminators(candidate);
  return (
    discriminators.length > 0 &&
    discriminators.every(
      ([key, property]) => isRecord(property) && value[key] === property["const"]
    )
  );
}

function requiredLiteralDiscriminators(
  candidate: unknown
): Array<[string, Record<string, unknown>]> {
  if (!isRecord(candidate) || !isRecord(candidate["properties"])) return [];
  const required = new Set(
    Array.isArray(candidate["required"])
      ? candidate["required"].filter((key): key is string => typeof key === "string")
      : []
  );
  return Object.entries(candidate["properties"]).filter(
    (entry): entry is [string, Record<string, unknown>] =>
      required.has(entry[0]) && isRecord(entry[1]) && Object.hasOwn(entry[1], "const")
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
