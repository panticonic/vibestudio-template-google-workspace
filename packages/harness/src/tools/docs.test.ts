import { describe, expect, it } from "vitest";
import { createDocsSearchTool, renderEntry, type CatalogEntry } from "./docs.js";

describe("docs_search", () => {
  it("caps oversized result requests instead of turning discovery into a tool error", async () => {
    const calls: Array<{ method: string; args: unknown[] }> = [];
    const tool = createDocsSearchTool(async <T>(method: string, args: unknown[]) => {
      calls.push({ method, args });
      return [] as T;
    });

    await tool.execute("call-1", { query: "runtime", limit: 200 });

    expect(calls).toEqual([
      { method: "docs.search", args: ["runtime", { surface: undefined, limit: 100 }] },
    ]);
  });

  it("forwards cancellation to catalog discovery", async () => {
    const observed: Array<AbortSignal | undefined> = [];
    const tool = createDocsSearchTool(
      async <T>(_method: string, _args: unknown[], signal?: AbortSignal) => {
        observed.push(signal);
        return [] as T;
      }
    );
    const controller = new AbortController();

    await tool.execute("call-signal", { query: "runtime" }, controller.signal);

    expect(observed).toEqual([controller.signal]);
  });
});

describe("renderEntry (readable docs_open text)", () => {
  it("renders a readable signature instead of a raw JSON-schema dump", () => {
    const entry: CatalogEntry = {
      id: "service:blobstore.getText",
      surface: "service",
      qualifiedName: "blobstore.getText",
      title: "blobstore.getText",
      description: "Full UTF-8 text of a blob, or null if absent.",
      access: { sensitivity: "read", callers: ["panel", "do"] },
      argsSchema: {
        type: "array",
        minItems: 1,
        maxItems: 1,
        items: [{ type: "string", pattern: "^[0-9a-f]{64}$" }],
      },
      returnsSchema: { type: "string", nullable: true },
      examples: [{ args: ["e3b0c4"] }],
    };
    const text = renderEntry(entry);

    expect(text).toContain("blobstore.getText(string /^[0-9a-f]{64}$/) → string | null");
    expect(text).toContain("Full UTF-8 text of a blob");
    expect(text).toContain("Sensitivity: read");
    expect(text).toContain('blobstore.getText("e3b0c4")'); // readable example call
    // the raw JSON-schema dump is gone
    expect(text).not.toContain("Args schema:");
    expect(text).not.toContain('"type": "array"');
  });

  it("names parameters in the signature, breakdown, and rpc example when the catalog carries argumentNames", () => {
    const entry: CatalogEntry = {
      id: "service:docs.search",
      surface: "service",
      qualifiedName: "docs.search",
      title: "docs.search",
      argumentNames: ["query", "options"],
      argsSchema: {
        type: "array",
        minItems: 1,
        maxItems: 2,
        items: [
          { type: "string", description: "Keyword query." },
          { type: "object", properties: { limit: { type: "integer" } } },
        ],
      },
    };

    const text = renderEntry(entry);

    expect(text).toContain("docs.search(query: string, options?: { limit?: integer })");
    expect(text).toContain("query: string — Keyword query.");
    expect(text).toContain('await rpc.call("main", "docs.search", ["query", { ... }])');
    expect(text).not.toContain("arg0");
  });

  it("renders object args with field types, optional markers, and field docs", () => {
    const entry: CatalogEntry = {
      id: "service:feeds.add",
      surface: "service",
      qualifiedName: "feeds.add",
      title: "feeds.add",
      argsSchema: {
        type: "array",
        items: [
          {
            type: "object",
            properties: {
              feedId: { type: "string", description: "the feed id" },
              limit: { type: "integer" },
            },
            required: ["feedId"],
          },
        ],
      },
    };
    const text = renderEntry(entry);
    expect(text).toContain("feeds.add({ feedId: string; limit?: integer })");
    expect(text).toContain(".feedId: string — the feed id");
  });

  it("shows the raw rpc.call form for service methods", () => {
    const entry: CatalogEntry = {
      id: "service:workers.listSources",
      surface: "service",
      qualifiedName: "workers.listSources",
      title: "workers.listSources",
      argsSchema: {
        type: "array",
        minItems: 0,
        maxItems: 0,
        items: [],
      },
    };
    const text = renderEntry(entry);

    expect(text).toContain('await rpc.call("main", "workers.listSources", [])');
    expect(text).toContain("services.<name>");
    expect(text).toContain("ergonomic runtime client");
    expect(text).toContain("authority, and session-admission checks still apply");
    expect(text).not.toContain("always reachable");
  });

  it("warns eval callers when a service method requires durable code identity", () => {
    const entry: CatalogEntry = {
      id: "service:development.start",
      surface: "service",
      qualifiedName: "development.start",
      title: "development.start",
      access: {
        sensitivity: "write",
        principals: ["code"],
        sessionAdmission: "codeOnly",
      },
      argsSchema: {
        type: "array",
        items: [{ type: "object" }, { type: "object" }],
      },
    };

    const text = renderEntry(entry);
    expect(text).toContain("Caller identity: durable code only");
    expect(text).toContain("cannot be called from eval/session code");
    expect(text).toContain("cannot manufacture a durable identity");
  });

  it("shows the public runtime import form for projected namespace methods", () => {
    const entry: CatalogEntry = {
      id: "runtime:workerRuntime.webhooks.createSubscription",
      surface: "runtime",
      qualifiedName: "webhooks.createSubscription",
      title: "webhooks.createSubscription",
      argsSchema: {
        type: "array",
        items: [{ type: "object", properties: { target: { type: "object" } } }],
      },
    };

    const text = renderEntry(entry);
    expect(text).toContain('import { webhooks } from "@workspace/runtime"');
    expect(text).toContain("await webhooks.createSubscription(...)");
    expect(text).not.toContain("rpc.call");
  });

  it("puts live protocol resolution and installed authority on workspace service roots", () => {
    const entry: CatalogEntry = {
      id: "workspace:notes",
      surface: "workspace",
      qualifiedName: "notes",
      title: "Notes",
      members: ["get"],
      access: {
        protocols: ["example.notes.v1"],
        capability: "workspace-service:notes",
        source: "workers/notes",
        target: { kind: "durable-object", className: "NotesDO", defaultObjectKey: "notes" },
      },
    };

    const text = renderEntry(entry);
    expect(text).toContain("Protocol: example.notes.v1");
    expect(text).toContain('"workspace-service:notes"');
    expect(text).toContain('tier "gated"');
    expect(text).toContain('RPC tier "open" is a separate receiver policy');
    expect(text).toContain('workers.resolveService("example.notes.v1")');
    expect(text).toContain('import { workers, rpc } from "@workspace/runtime"');
    expect(text).toContain('runtime.workers.resolveService("example.notes.v1")');
    expect(text).toContain("Resolve and call it directly through the runtime");
  });

  it("distinguishes declared service wiring from eval authority", () => {
    const entry: CatalogEntry = {
      id: "workspace:gad.workspace",
      surface: "workspace",
      qualifiedName: "gad.workspace",
      title: "Workspace source",
      members: ["vcsStatus"],
      access: {
        protocols: ["vibestudio.gad.workspace.v1"],
        binding: "declared",
        declarationCapability: "workspace-service:gad.workspace",
        source: "workers/workspace-source",
        target: {
          kind: "durable-object",
          className: "GadWorkspaceDO",
          defaultObjectKey: "workspace",
        },
      },
    };

    const text = renderEntry(entry);
    expect(text).toContain("Installed-unit declaration");
    expect(text).toContain('"workspace-service:gad.workspace"');
    expect(text).toContain("not a runtime permission");
    expect(text).toContain("must not be added to eval authority requests");
    expect(text).not.toContain("Installed-unit authority");
  });

  it("requires an explicit object key when workspace docs describe a DO factory", () => {
    const entry: CatalogEntry = {
      id: "workspace:channel.publish",
      surface: "workspace",
      qualifiedName: "channel.publish",
      parent: "workspace:channel",
      title: "channel.publish",
      signature: "publish(): Promise<void>",
      access: {
        protocols: ["vibestudio.channel.v1"],
        target: {
          kind: "durable-object",
          className: "PubSubChannel",
          defaultObjectKey: null,
        },
      },
    };

    const text = renderEntry(entry);

    expect(text).toContain("const objectKey = /* exact provider object key");
    expect(text).toContain('workers.resolveService("vibestudio.channel.v1", objectKey)');
    expect(text).not.toContain('workers.resolveService("vibestudio.channel.v1");');
  });
});
