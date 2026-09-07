/**
 * Capability-discovery tools — `docs_search` / `docs_open`.
 *
 * Thin RPC tools over the server `docs` service (the caller-aware capability
 * catalog). `docs_search` returns compact hits; `docs_open` returns the full
 * entry (typed args/returns JSON Schema, access/restrictedness, examples).
 *
 * The server catalog covers the implemented automatically documented surfaces:
 * service RPC methods and runtime API namespaces.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";

/** Wire shapes (structural; mirror packages/service-schemas/src/docs.ts). */
export interface CatalogHit {
  id: string;
  surface: string;
  qualifiedName: string;
  title: string;
  description?: string;
}
export interface CatalogEntry extends CatalogHit {
  parent?: string;
  access?: Record<string, unknown>;
  argsSchema?: Record<string, unknown>;
  returnsSchema?: Record<string, unknown>;
  /** Author-facing parameter names, positionally matching the args tuple. */
  argumentNames?: string[];
  members?: string[];
  examples?: unknown[];
  signature?: string;
}

const surfaceParam = Type.Optional(
  Type.Union([Type.Literal("service"), Type.Literal("runtime"), Type.Literal("workspace")], {
    description: "Restrict results to one surface.",
  })
);

const searchSchema = Type.Object(
  {
    query: Type.String({
      description:
        "Keywords describing the capability you want, e.g. 'store a blob and get a digest'.",
    }),
    surface: surfaceParam,
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Requested result count (default 20; safely capped at 100).",
      })
    ),
  },
  { additionalProperties: false }
);
export type DocsSearchInput = Static<typeof searchSchema>;

const openSchema = Type.Object(
  {
    id: Type.String({
      description: "Catalog id from docs_search, e.g. 'service:blobstore.putText'.",
    }),
  },
  { additionalProperties: false }
);
export type DocsOpenInput = Static<typeof openSchema>;

const MAX_SCHEMA_CHARS = 6_000;

function clamp(text: string, max: number): string {
  return text.length <= max
    ? text
    : `${text.slice(0, max)}\n…[truncated ${text.length - max} chars]`;
}

export function createDocsSearchTool(
  callMain: <T>(method: string, args: unknown[], signal?: AbortSignal) => Promise<T>
): AgentTool<typeof searchSchema> {
  return {
    name: "docs_search",
    label: "docs_search",
    executionMode: "parallel",
    description:
      'Agent tool only (not an eval global/export). Call as docs_search({ query: "keywords", surface?, limit? }). Search the capability catalog — host services, runtime APIs, and live workspace services — by keyword. Returns compact hits filtered to what you may call; use docs_open({ id: "<result-id>" }) for the full contract before starting eval.',
    parameters: searchSchema,
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<CatalogHit[]>> => {
      if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
      const limit = Math.min(params.limit ?? 20, 100);
      const serverHits = await callMain<CatalogHit[]>(
        "docs.search",
        [params.query, { surface: params.surface, limit }],
        signal
      );
      const hits = serverHits.slice(0, limit);
      if (hits.length === 0) {
        return {
          content: [
            {
              type: "text",
              text: `No catalog matches for "${params.query}". Try broader keywords, or a different surface.`,
            },
          ],
          details: hits,
        };
      }
      const lines = hits.map(
        (h) => `${h.id}  —  ${h.title}${h.description ? `: ${h.description}` : ""}`
      );
      return {
        content: [
          {
            type: "text",
            text: `${lines.join("\n")}\n\n(${hits.length} result${hits.length === 1 ? "" : "s"}. Use docs_open({ id: "<result-id>" }) for the full schema, access rules, and examples.)`,
          },
        ],
        details: hits,
      };
    },
  };
}

type JsonSchema = Record<string, unknown>;

/**
 * Render a JSON-Schema node (as emitted by zod-to-json-schema, openApi3 target)
 * as a readable TypeScript-ish type — far more legible for an agent than a raw
 * `JSON.stringify(schema)` dump. Unknown shapes degrade to their `type` or
 * "unknown"; the precise schema is still available via `docs.getSchema`.
 */
function typeString(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "unknown";
  const s = schema as JsonSchema;
  if (s["nullable"] === true) {
    const inner = { ...s };
    delete inner["nullable"];
    return `${typeString(inner)} | null`;
  }
  if (Array.isArray(s["enum"])) {
    return (s["enum"] as unknown[]).map((v) => JSON.stringify(v)).join(" | ");
  }
  if ("const" in s) return JSON.stringify(s["const"]);
  const union = (s["anyOf"] ?? s["oneOf"]) as unknown[] | undefined;
  if (Array.isArray(union)) return union.map(typeString).join(" | ");
  const t = s["type"];
  if (Array.isArray(t)) return t.map(String).join(" | ");
  switch (t) {
    case "string": {
      if (typeof s["pattern"] === "string") return `string /${s["pattern"] as string}/`;
      if (typeof s["format"] === "string") return `string (${s["format"] as string})`;
      return "string";
    }
    case "integer":
      return "integer";
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array": {
      const items = s["items"];
      if (Array.isArray(items)) return `[${items.map(typeString).join(", ")}]`;
      return `${typeString(items)}[]`;
    }
    default: {
      const props = s["properties"];
      if (props && typeof props === "object") {
        const required = new Set((s["required"] as string[] | undefined) ?? []);
        const fields = Object.entries(props as Record<string, unknown>).map(
          ([key, value]) => `${key}${required.has(key) ? "" : "?"}: ${typeString(value)}`
        );
        return `{ ${fields.join("; ")} }`;
      }
      return "unknown";
    }
  }
}

/** A method's tuple args schema → a readable parameter list, e.g.
 *  `(string /^[0-9a-f]{64}$/, number?)` — or, when the catalog carries the
 *  author-facing parameter names, `(query: string, options?: number)`. */
function describeArgs(argsSchema: unknown, argumentNames?: string[]): string {
  const s = argsSchema as JsonSchema | undefined;
  const tuple = s?.["prefixItems"] ?? s?.["items"];
  if (!s || s["type"] !== "array" || !Array.isArray(tuple)) {
    return s ? `(${typeString(s)})` : "()";
  }
  const items = tuple as unknown[];
  const min = typeof s["minItems"] === "number" ? (s["minItems"] as number) : items.length;
  return `(${items
    .map((item, i) => {
      const optional = i >= min;
      const name = argumentNames?.[i];
      return name
        ? `${name}${optional ? "?" : ""}: ${typeString(item)}`
        : `${typeString(item)}${optional ? "?" : ""}`;
    })
    .join(", ")})`;
}

/** Surface the `.describe()` docs on tuple args + their object fields as a
 *  "Parameters:" block (only the ones that actually carry a description). */
function argBreakdown(argsSchema: unknown, argumentNames?: string[]): string {
  const s = argsSchema as JsonSchema | undefined;
  const tuple = s?.["prefixItems"] ?? s?.["items"];
  const items = s && s["type"] === "array" && Array.isArray(tuple) ? (tuple as unknown[]) : [];
  const lines: string[] = [];
  items.forEach((item, i) => {
    const arg = item as JsonSchema;
    if (typeof arg["description"] === "string") {
      lines.push(
        `  ${argumentNames?.[i] ?? `arg${i}`}: ${typeString(item)} — ${arg["description"] as string}`
      );
    }
    const props = arg["properties"];
    if (props && typeof props === "object") {
      for (const [key, value] of Object.entries(props as Record<string, unknown>)) {
        const fieldDesc = (value as JsonSchema)["description"];
        if (typeof fieldDesc === "string") {
          lines.push(`  .${key}: ${typeString(value)} — ${fieldDesc}`);
        }
      }
    }
  });
  return lines.length > 0 ? `Parameters:\n${lines.join("\n")}` : "";
}

/** Examples (`{ args: [...] }`) → readable call lines, e.g. `blobstore.putText("hi")`. */
function formatExamples(qualifiedName: string, examples: unknown[]): string {
  return examples
    .map((ex) => {
      const args =
        ex && typeof ex === "object" && Array.isArray((ex as { args?: unknown[] }).args)
          ? (ex as { args: unknown[] }).args
          : undefined;
      return args
        ? `${qualifiedName}(${args.map((a) => JSON.stringify(a)).join(", ")})`
        : JSON.stringify(ex);
    })
    .join("\n");
}

function serviceRpcExample(
  qualifiedName: string,
  argsSchema: unknown,
  argumentNames?: string[]
): string | null {
  const s = argsSchema as JsonSchema | undefined;
  const tuple = s?.["prefixItems"] ?? s?.["items"];
  if (!s || s["type"] !== "array" || !Array.isArray(tuple)) return null;
  const items = tuple as unknown[];
  const args = items.map((item, index) => {
    const type = typeString(item);
    if (type.startsWith("{ ")) return "{ ... }";
    if (type === "string" || type.startsWith("string "))
      return `"${argumentNames?.[index] ?? `arg${index}`}"`;
    if (type === "integer" || type === "number") return "0";
    if (type === "boolean") return "false";
    if (type.endsWith("[]")) return "[]";
    return `/* ${type} */`;
  });
  return `await rpc.call("main", ${JSON.stringify(qualifiedName)}, [${args.join(", ")}])`;
}

export function renderEntry(entry: CatalogEntry): string {
  const parts: string[] = [`# ${entry.qualifiedName}  (${entry.surface})`];
  if (entry.description) parts.push(entry.description);
  if (entry.signature) parts.push(entry.signature);
  if (entry.access) {
    const a = entry.access as {
      callers?: string[];
      principals?: string[];
      sensitivity?: string;
      sessionAdmission?: "family" | "codeOnly";
      restrictedTo?: Array<{ when: string; callers: string[]; reason: string }>;
      approval?: Array<{ when?: string; capability?: string; reason: string }>;
      requires?: Array<{ kind: string; description: string }>;
    };
    if (Array.isArray(a.callers)) parts.push(`Callers: ${a.callers.join(", ")}`);
    if (a.sensitivity) parts.push(`Sensitivity: ${a.sensitivity}`);
    for (const r of Array.isArray(a.restrictedTo) ? a.restrictedTo : []) {
      if (!r || !Array.isArray(r.callers)) continue;
      parts.push(`Restricted: ${r.reason} — when ${r.when}, only [${r.callers.join(", ")}]`);
    }
    for (const ap of Array.isArray(a.approval) ? a.approval : []) {
      parts.push(
        `Approval: ${ap.reason}${ap.capability ? ` (capability: ${ap.capability})` : ""}${ap.when ? ` — when ${ap.when}` : ""}`
      );
    }
    for (const req of Array.isArray(a.requires) ? a.requires : []) {
      parts.push(`Requires ${req.kind}: ${req.description}`);
    }
    if (a.sessionAdmission === "codeOnly") {
      parts.push(
        "Caller identity: durable code only. This method cannot be called from eval/session code, " +
          "and a caller descriptor cannot manufacture a durable identity. Use a session-admitted " +
          "method when the action originates in eval."
      );
    }
  }
  if (Array.isArray(entry.members)) parts.push(`Members: ${entry.members.join(", ")}`);
  // Readable signature + parameter docs instead of raw JSON-schema dumps (the full
  // typed schema is still available via docs.getSchema / the panel's schema view).
  if (entry.argsSchema || entry.returnsSchema) {
    const sig = `${entry.qualifiedName}${describeArgs(entry.argsSchema, entry.argumentNames)}`;
    parts.push(
      clamp(
        entry.returnsSchema ? `${sig} → ${typeString(entry.returnsSchema)}` : sig,
        MAX_SCHEMA_CHARS
      )
    );
    const breakdown = argBreakdown(entry.argsSchema, entry.argumentNames);
    if (breakdown) parts.push(clamp(breakdown, MAX_SCHEMA_CHARS));
    if (entry.surface === "service") {
      const rpcExample = serviceRpcExample(
        entry.qualifiedName,
        entry.argsSchema,
        entry.argumentNames
      );
      if (rpcExample) {
        parts.push(
          `Eval/raw RPC call:\n${rpcExample}\n\n` +
            "The portable `rpc.call(target, method, args)` form addresses this service; normal caller, authority, and session-admission checks still apply. " +
            "The `services.<name>` convenience binding may be an ergonomic runtime client when " +
            "the service name also exists in `@workspace/runtime`."
        );
      }
    } else if (entry.surface === "runtime") {
      const [namespace] = entry.qualifiedName.split(".");
      if (namespace && entry.qualifiedName.includes(".")) {
        parts.push(
          `Eval/runtime call:\nimport { ${namespace} } from "@workspace/runtime";\n` +
            `await ${entry.qualifiedName}(...);`
        );
      }
    }
  }
  if (entry.surface === "workspace") {
    const access = entry.access as
      | {
          protocols?: string[];
          target?: { kind?: string; defaultObjectKey?: string | null };
          source?: string;
          capability?: string;
          declarationCapability?: string;
          binding?: "consent" | "declared";
        }
      | undefined;
    const protocol = access?.protocols?.[0];
    if (protocol) {
      parts.push(`Protocol: ${protocol}`);
      const manifestCapability = access?.declarationCapability ?? access?.capability;
      if (!entry.parent && manifestCapability) {
        parts.push(
          access?.binding === "declared"
            ? `Installed-unit declaration: declare an exact ${JSON.stringify(
                manifestCapability
              )} request in the caller's package.json with resource { "kind": "prefix", "prefix": "" }, tier "gated", and evidence "bounded-dynamic". This records reviewed structural wiring; it is not a runtime permission and must not be added to eval authority requests. Individual receiver methods and their semantic effects remain authoritative.`
            : `Installed-unit authority: declare an exact ${JSON.stringify(
                manifestCapability
              )} request in the caller's package.json with resource { "kind": "prefix", "prefix": "" }, tier "gated", and evidence "bounded-dynamic". Manifest tiers are only "gated" or "critical"; the provider method's RPC tier "open" is a separate receiver policy. This request may exist before the provider; the live declaration, provider version, context visibility, and grant are still checked at runtime.`
        );
      }
      const callExample = entry.parent
        ? 'if (service.kind !== "durable-object") throw new Error("Expected a Durable Object service");\n' +
          `await rpc.call(service.targetId, ${JSON.stringify(
            entry.qualifiedName.split(".").at(-1)
          )}, [/* args */]);`
        : "// Open the method docs listed above, then call its exact method through rpc.call(...).";
      const factoryObjectKey =
        access?.target?.kind === "durable-object" && access.target.defaultObjectKey === null
          ? "const objectKey = /* exact provider object key from the task/runtime context */;\n"
          : "";
      const resolutionArgs =
        access?.target?.kind === "durable-object" && access.target.defaultObjectKey === null
          ? `${JSON.stringify(protocol)}, objectKey`
          : JSON.stringify(protocol);
      parts.push(
        "Finish docs_search/docs_open as agent tools before eval; `docs`, `docs.search`, and `docs.open` are not eval globals or runtime exports.\n\n" +
          "This is a live workspace service. Resolve and call it directly through the runtime below; its receiver declaration and installed-unit authority are enforced by that call.\n\n" +
          "Eval-side service resolution and proof (public exports only):\n" +
          'import { workers, rpc } from "@workspace/runtime";\n' +
          factoryObjectKey +
          `const service = await workers.resolveService(${resolutionArgs});\n` +
          callExample +
          "\n\nInstalled worker code uses the runtime created inside fetch():\n" +
          factoryObjectKey +
          `const service = await runtime.workers.resolveService(${resolutionArgs});\n` +
          callExample.replaceAll("rpc.call", "runtime.rpc.call")
      );
    }
  }
  if (entry.examples?.length) {
    parts.push(
      `Examples:\n${clamp(formatExamples(entry.qualifiedName, entry.examples), MAX_SCHEMA_CHARS)}`
    );
  }
  return parts.join("\n\n");
}

export function createDocsOpenTool(
  callMain: <T>(method: string, args: unknown[], signal?: AbortSignal) => Promise<T>
): AgentTool<typeof openSchema> {
  return {
    name: "docs_open",
    label: "docs_open",
    executionMode: "parallel",
    description:
      'Agent tool only (not an eval global/export). Call exactly as docs_open({ id: "<catalog-id>" }). Open one result from docs_search before starting eval: source signature or typed schema, access rules, examples, and live workspace-provider identity.',
    parameters: openSchema,
    execute: async (_toolCallId, params, signal): Promise<AgentToolResult<CatalogEntry | null>> => {
      if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
      const entry = await callMain<CatalogEntry | null>("docs.describe", [params.id], signal);
      if (!entry) {
        return {
          content: [
            {
              type: "text",
              text: `No catalog entry "${params.id}" (unknown, or not callable by you). Use docs_search to find ids.`,
            },
          ],
          details: null,
        };
      }
      return {
        content: [{ type: "text", text: renderEntry(entry) }],
        details: entry,
      };
    },
  };
}
