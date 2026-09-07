// @vitest-environment jsdom

import React, { useEffect } from "react";
import * as ReactJsxRuntime from "react/jsx-runtime";
import * as ReactJsxDevRuntime from "react/jsx-dev-runtime";
import * as RadixIcons from "@radix-ui/react-icons";
import * as RadixThemes from "@radix-ui/themes";
import * as ReactResponsive from "@workspace/react/responsive";
import * as ShellSurface from "@vibestudio/shared/shellSurface";
import { act, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONTENT_TYPE_INLINE_UI } from "@workspace/pubsub";
import { useActionBar } from "./useActionBar";
import { useInlineUi } from "./useInlineUi";
import type { ActionBarHookState } from "./useActionBar";
import type { InlineUiState } from "./useInlineUi";
import type { ChatMessage } from "../../types";

function makeMessage(content: unknown): ChatMessage {
  return {
    id: "msg-1",
    senderId: "agent-1",
    content: JSON.stringify(content),
    contentType: CONTENT_TYPE_INLINE_UI,
    kind: "message",
    complete: true,
  } as ChatMessage;
}

describe("sandbox source hooks", () => {
  let originalModuleMap: unknown;
  let originalRequire: unknown;
  let originalPreload: unknown;
  let originalRequestIdleCallback:
    | typeof globalThis.requestIdleCallback
    | undefined;
  let originalCancelIdleCallback:
    | typeof globalThis.cancelIdleCallback
    | undefined;

  beforeEach(() => {
    originalModuleMap = (globalThis as Record<string, unknown>)[
      "__vibestudioModuleMap__"
    ];
    originalRequire = (globalThis as Record<string, unknown>)[
      "__vibestudioRequire__"
    ];
    originalPreload = (globalThis as Record<string, unknown>)[
      "__vibestudioPreloadModules__"
    ];
    originalRequestIdleCallback = globalThis.requestIdleCallback;
    originalCancelIdleCallback = globalThis.cancelIdleCallback;

    const moduleMap: Record<string, unknown> = {};
    (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] =
      moduleMap;
    (globalThis as Record<string, unknown>)["__vibestudioRequire__"] = (
      id: string,
    ) => {
      if (id in moduleMap) return moduleMap[id];
      throw new Error(`Module not found: ${id}`);
    };
    (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] =
      async (ids: string[]) =>
        ids.map((id) => {
          if (id in moduleMap) return moduleMap[id];
          throw new Error(`Module not found: ${id}`);
        });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalModuleMap === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"];
    else
      (globalThis as Record<string, unknown>)["__vibestudioModuleMap__"] =
        originalModuleMap;
    if (originalRequire === undefined)
      delete (globalThis as Record<string, unknown>)["__vibestudioRequire__"];
    else
      (globalThis as Record<string, unknown>)["__vibestudioRequire__"] =
        originalRequire;
    if (originalPreload === undefined)
      delete (globalThis as Record<string, unknown>)[
        "__vibestudioPreloadModules__"
      ];
    else
      (globalThis as Record<string, unknown>)["__vibestudioPreloadModules__"] =
        originalPreload;
    if (originalRequestIdleCallback === undefined)
      delete (globalThis as Record<string, unknown>)["requestIdleCallback"];
    else globalThis.requestIdleCallback = originalRequestIdleCallback;
    if (originalCancelIdleCallback === undefined)
      delete (globalThis as Record<string, unknown>)["cancelIdleCallback"];
    else globalThis.cancelIdleCallback = originalCancelIdleCallback;
  });

  it("compiles inline_ui file sources with package.json inferred imports", async () => {
    const states: InlineUiState[] = [];
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const loadSourceFile = async (path: string) => {
      if (path === "packages/app/ui.tsx")
        return `import { label } from "label-lib"; export default function App() { return label; }`;
      if (path === "packages/app/package.json")
        return JSON.stringify({ dependencies: { "label-lib": "2" } });
      throw new Error(`Missing ${path}`);
    };
    const loadImport = async (specifier: string, ref: string | undefined) => {
      loadCalls.push({ specifier, ref });
      return {
        bundle: `module.exports = { label: "ready" };`,
        format: "cjs" as const,
      };
    };
    const messages = [
      makeMessage({
        id: "ui-1",
        source: { type: "file", path: "packages/app/ui.tsx" },
      }),
    ];

    function Harness() {
      const state = useInlineUi({ messages, loadSourceFile, loadImport });
      useEffect(() => {
        states.push(state);
      }, [state]);
      return null;
    }

    render(<Harness />);

    await waitFor(
      () => {
        const entry = states[states.length - 1]?.inlineUiComponents.get("ui-1");
        expect(entry?.Component).toBeTruthy();
      },
      { timeout: 5_000 },
    );
    expect(loadCalls).toEqual([{ specifier: "label-lib", ref: "npm:2" }]);
  });

  it("loads explicit inline_ui imports from a replayed payload", async () => {
    const states: InlineUiState[] = [];
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const messages = [
      makeMessage({
        id: "replayed-ui",
        source: {
          type: "code",
          code: `import { label } from "label-lib"; export default function App() { return label; }`,
        },
        imports: { "label-lib": "npm:2" },
        renderedAt: "2026-08-12T08:00:00.000Z",
      }),
    ];
    const loadImport = async (specifier: string, ref: string | undefined) => {
      loadCalls.push({ specifier, ref });
      return {
        bundle: `module.exports = { label: "ready" };`,
        format: "cjs" as const,
      };
    };

    function Harness() {
      const state = useInlineUi({ messages, loadImport });
      useEffect(() => {
        states.push(state);
      }, [state]);
      return null;
    }

    render(<Harness />);

    await waitFor(() => {
      const entry = states.at(-1)?.inlineUiComponents.get("replayed-ui");
      expect(entry?.error).toBeUndefined();
      expect(entry?.Component).toBeTruthy();
    });
    expect(loadCalls).toEqual([{ specifier: "label-lib", ref: "npm:2" }]);
  });

  it("keeps authored console output on the compiled inline UI entry", async () => {
    const states: InlineUiState[] = [];
    const messages = [
      makeMessage({
        id: "diagnostic-ui",
        source: {
          type: "code",
          code: `
            console.info("module initialized");
            export default function App() {
              console.warn("component rendered");
              return "ready";
            }
          `,
        },
      }),
    ];

    function Harness() {
      const state = useInlineUi({ messages });
      useEffect(() => {
        states.push(state);
      }, [state]);
      const Component =
        state.inlineUiComponents.get("diagnostic-ui")?.Component;
      return Component ? (
        <Component props={{}} chat={{}} scope={{}} scopes={{}} />
      ) : null;
    }

    const view = render(<Harness />);

    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    await waitFor(() => {
      const consoleEntries = states
        .at(-1)
        ?.inlineUiComponents.get("diagnostic-ui")
        ?.runtime?.console.getEntries();
      expect(
        consoleEntries?.map((entry) => [entry.level, entry.args[0]]),
      ).toEqual([
        ["info", "module initialized"],
        ["warn", "component rendered"],
      ]);
    });
  });

  it("reloads an inline_ui import when a stable card changes its declared ref", async () => {
    const code = `import { label } from "label-lib"; export default function App() { return label; }`;
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const loadImport = async (specifier: string, ref: string | undefined) => {
      loadCalls.push({ specifier, ref });
      return {
        bundle: `module.exports = { label: ${JSON.stringify(ref)} };`,
        format: "cjs" as const,
      };
    };
    const message = (ref: string, renderedAt: string) =>
      makeMessage({
        id: "versioned-card",
        source: { type: "code", code },
        imports: { "label-lib": ref },
        renderedAt,
      });

    function Harness({ messages }: { messages: ChatMessage[] }) {
      const state = useInlineUi({ messages, loadImport });
      const Component =
        state.inlineUiComponents.get("versioned-card")?.Component;
      return Component ? (
        <Component props={{}} chat={{}} scope={{}} scopes={{}} />
      ) : (
        <div>loading</div>
      );
    }

    const view = render(
      <Harness messages={[message("npm:1", "first-revision")]} />,
    );
    await waitFor(() => expect(view.getByText("npm:1")).toBeTruthy());

    view.rerender(<Harness messages={[message("npm:2", "second-revision")]} />);

    await waitFor(() => expect(view.getByText("npm:2")).toBeTruthy());
    expect(view.queryByText("npm:1")).toBeNull();
    expect(loadCalls).toEqual([
      { specifier: "label-lib", ref: "npm:1" },
      { specifier: "label-lib", ref: "npm:2" },
    ]);
  });

  it("serializes in-flight stable-card revisions before changing package refs", async () => {
    const moduleMap = (globalThis as Record<string, unknown>)[
      "__vibestudioModuleMap__"
    ] as Record<string, unknown>;
    let releaseFirstImport!: () => void;
    const firstImportGate = new Promise<void>((resolve) => {
      releaseFirstImport = resolve;
    });
    const loadCalls: Array<string | undefined> = [];
    const loadImport = async (_specifier: string, ref: string | undefined) => {
      loadCalls.push(ref);
      if (ref === "npm:1") await firstImportGate;
      return {
        bundle: `module.exports = { label: ${JSON.stringify(ref)} };`,
        format: "cjs" as const,
      };
    };
    const code = `import { label } from "label-lib"; export default function App() { return label; }`;
    const message = (ref: string, renderedAt: string) =>
      makeMessage({
        id: "racing-card",
        source: { type: "code", code },
        imports: { "label-lib": ref },
        renderedAt,
      });

    function Harness({ messages }: { messages: ChatMessage[] }) {
      const state = useInlineUi({ messages, loadImport });
      const Component = state.inlineUiComponents.get("racing-card")?.Component;
      return Component ? (
        <Component props={{}} chat={{}} scope={{}} scopes={{}} />
      ) : (
        <div>loading</div>
      );
    }

    const view = render(
      <Harness messages={[message("npm:1", "first-revision")]} />,
    );
    await waitFor(() => expect(loadCalls).toEqual(["npm:1"]));

    view.rerender(<Harness messages={[message("npm:2", "second-revision")]} />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(loadCalls).toEqual(["npm:1"]);

    releaseFirstImport();
    await waitFor(() => expect(view.getByText("npm:2")).toBeTruthy());
    expect(loadCalls).toEqual(["npm:1", "npm:2"]);
    expect(moduleMap["label-lib"]).toEqual({ label: "npm:2" });
  });

  it("recompiles a stable inline_ui id when the file at the same path changes", async () => {
    let source = `export default function App() { return "first"; }`;
    let sourceReads = 0;
    const loadSourceFile = async (sourcePath: string) => {
      if (sourcePath !== "packages/app/Card.tsx")
        throw new Error(`Missing ${sourcePath}`);
      sourceReads += 1;
      return source;
    };
    const message = (renderedAt: string) =>
      makeMessage({
        id: "stable-card",
        source: { type: "file", path: "packages/app/Card.tsx" },
        renderedAt,
      });

    function Harness({ messages }: { messages: ChatMessage[] }) {
      const state = useInlineUi({ messages, loadSourceFile });
      const Component = state.inlineUiComponents.get("stable-card")?.Component;
      return Component ? (
        <Component props={{}} chat={{}} scope={{}} scopes={{}} />
      ) : (
        <div>loading</div>
      );
    }

    const view = render(<Harness messages={[message("first-revision")]} />);
    await waitFor(() => expect(view.getByText("first")).toBeTruthy());

    source = `export default function App() { return "second"; }`;
    view.rerender(<Harness messages={[message("second-revision")]} />);

    await waitFor(() => expect(view.getByText("second")).toBeTruthy());
    expect(view.queryByText("first")).toBeNull();
    expect(sourceReads).toBe(2);
  });

  it("retries a failed stable inline_ui compilation on the next render revision", async () => {
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    let source = `export default function (`;
    const message = (renderedAt: string) =>
      makeMessage({
        id: "repairable-card",
        source: { type: "file", path: "packages/app/Repairable.tsx" },
        renderedAt,
      });

    function Harness({ messages }: { messages: ChatMessage[] }) {
      const state = useInlineUi({
        messages,
        loadSourceFile: async () => source,
      });
      const entry = state.inlineUiComponents.get("repairable-card");
      const Component = entry?.Component;
      if (entry?.error) return <div>{entry.error}</div>;
      return Component ? (
        <Component props={{}} chat={{}} scope={{}} scopes={{}} />
      ) : (
        <div>loading</div>
      );
    }

    const view = render(<Harness messages={[message("failed-revision")]} />);
    await waitFor(() => expect(view.queryByText("loading")).toBeNull());

    source = `export default function App() { return "recovered"; }`;
    view.rerender(<Harness messages={[message("repaired-revision")]} />);

    await waitFor(() => expect(view.getByText("recovered")).toBeTruthy());
    consoleError.mockRestore();
  });

  it("compiles the onboarding overview through the file-backed inline UI pipeline", async () => {
    const moduleMap = (globalThis as Record<string, unknown>)[
      "__vibestudioModuleMap__"
    ] as Record<string, unknown>;
    moduleMap["react"] = React;
    moduleMap["react/jsx-runtime"] = ReactJsxRuntime;
    moduleMap["react/jsx-dev-runtime"] = ReactJsxDevRuntime;
    moduleMap["@radix-ui/themes"] = RadixThemes;
    moduleMap["@radix-ui/react-icons"] = RadixIcons;
    moduleMap["@workspace/runtime"] = {};
    moduleMap["@workspace/model-catalog/catalog"] = {};
    moduleMap["@vibestudio/shared/shellSurface"] = ShellSurface;

    const sourcePath = "skills/onboarding/SetupHub.tsx";
    const workspaceRoot =
      process.env["VIBESTUDIO_USERLAND_ROOT"] ?? process.cwd();
    const states: InlineUiState[] = [];
    const messages = [
      makeMessage({
        id: "onboarding-setup-overview",
        source: { type: "file", path: sourcePath },
      }),
    ];

    function Harness() {
      const state = useInlineUi({
        messages,
        loadSourceFile: (sourceFilePath) =>
          readFile(path.join(workspaceRoot, sourceFilePath), "utf8"),
      });
      useEffect(() => {
        states.push(state);
      }, [state]);
      return null;
    }

    render(<Harness />);

    await waitFor(
      () => {
        const entry = states
          .at(-1)
          ?.inlineUiComponents.get("onboarding-setup-overview");
        expect(entry?.error).toBeUndefined();
        expect(entry?.Component).toBeTruthy();
      },
      { timeout: 5_000 },
    );
  });

  it("compiles action bar file sources with package.json inferred imports", async () => {
    const states: ActionBarHookState[] = [];
    const loadCalls: Array<{ specifier: string; ref: string | undefined }> = [];
    const loadSourceFile = async (path: string) => {
      if (path === "packages/app/bar.tsx")
        return `import { label } from "label-lib"; export default function Bar() { return label; }`;
      if (path === "packages/app/package.json")
        return JSON.stringify({ dependencies: { "label-lib": "3" } });
      throw new Error(`Missing ${path}`);
    };
    const loadImport = async (specifier: string, ref: string | undefined) => {
      loadCalls.push({ specifier, ref });
      return {
        bundle: `module.exports = { label: "ready" };`,
        format: "cjs" as const,
      };
    };
    const data = {
      id: "bar-1",
      source: { type: "file" as const, path: "packages/app/bar.tsx" },
    };

    function Harness() {
      const state = useActionBar({
        data,
        loadSourceFile,
        loadImport,
      });
      useEffect(() => {
        states.push(state);
      }, [state]);
      return null;
    }

    render(<Harness />);

    await waitFor(
      () => {
        const entry = states[states.length - 1]?.actionBar?.component;
        expect(entry?.error).toBeUndefined();
        expect(entry?.Component).toBeTruthy();
      },
      { timeout: 5_000 },
    );
    expect(loadCalls).toEqual([{ specifier: "label-lib", ref: "npm:3" }]);
  });

  it("starts action bar compilation as background work after primary panel effects", async () => {
    const events: string[] = [];
    const idleCallbacks = new Map<number, IdleRequestCallback>();
    let nextIdleHandle = 1;
    globalThis.requestIdleCallback = (callback) => {
      const handle = nextIdleHandle++;
      idleCallbacks.set(handle, callback);
      return handle;
    };
    globalThis.cancelIdleCallback = (handle) => {
      idleCallbacks.delete(handle);
    };

    function Harness() {
      const state = useActionBar({
        data: {
          id: "background-bar",
          source: { type: "file", path: "packages/app/bar.tsx" },
        },
        loadSourceFile: async () => {
          events.push("action-bar-source");
          return "export default function Bar() { return null; }";
        },
      });
      useEffect(() => {
        events.push("primary-panel-effect");
      }, []);
      return state.actionBar?.component?.Component ? <div>ready</div> : null;
    }

    const view = render(<Harness />);

    expect(events).toEqual(["primary-panel-effect"]);
    expect(view.queryByText("ready")).toBeNull();
    expect(idleCallbacks.size).toBe(1);

    const idleCallback = idleCallbacks.values().next().value;
    expect(idleCallback).toBeTypeOf("function");
    act(() => {
      idleCallback!({ didTimeout: false, timeRemaining: () => 50 });
    });

    await waitFor(() => expect(view.getByText("ready")).toBeTruthy());
    expect(events).toEqual(["primary-panel-effect", "action-bar-source"]);
  });

  it("renders the compiled model credential card with the panel's exposed modules", async () => {
    const moduleMap = (globalThis as Record<string, unknown>)[
      "__vibestudioModuleMap__"
    ] as Record<string, unknown>;
    moduleMap["react"] = React;
    moduleMap["react/jsx-runtime"] = ReactJsxRuntime;
    moduleMap["react/jsx-dev-runtime"] = ReactJsxDevRuntime;
    moduleMap["@radix-ui/themes"] = RadixThemes;
    moduleMap["@workspace/react/responsive"] = ReactResponsive;

    const sourcePath =
      "packages/agentic-chat/components/ModelCredentialRequiredCard.tsx";
    const workspaceRoot =
      process.env["VIBESTUDIO_USERLAND_ROOT"] ?? process.cwd();
    const source = await readFile(path.join(workspaceRoot, sourcePath), "utf8");
    const states: InlineUiState[] = [];
    const messages = [
      makeMessage({
        id: "model-credential-card",
        source: { type: "file", path: sourcePath },
        props: {
          providerId: "openai-codex",
          modelRef: "openai-codex:gpt-test",
          modelBaseUrl: "https://chatgpt.com/backend-api",
          flow: { type: "oauth-browser" },
        },
      }),
    ];

    function Harness() {
      const state = useInlineUi({
        messages,
        loadSourceFile: async (path) => {
          if (path === sourcePath) return source;
          throw new Error(`Missing ${path}`);
        },
      });
      useEffect(() => {
        states.push(state);
      }, [state]);
      const Component = state.inlineUiComponents.get(
        "model-credential-card",
      )?.Component;
      return Component ? (
        <Component
          props={JSON.parse(messages[0]!.content).props}
          chat={{ callMethod: async () => ({}) }}
          scope={{}}
          scopes={{}}
        />
      ) : null;
    }

    const view = render(<Harness />);

    await waitFor(() => {
      expect(
        states[states.length - 1]?.inlineUiComponents.get(
          "model-credential-card",
        )?.error,
      ).toBeUndefined();
      expect(view.getByText(/Credential required for/)).toBeTruthy();
    });
  });
});
