/**
 * Message-type doctor — an end-to-end health check for custom message types,
 * runnable in any jsdom test.
 *
 * For each spec it exercises the exact pipeline a panel runs:
 *
 *   1. synthesize the `messageType.registered` event and push it through the
 *      channel reducer (catches protocol/schema rejections — a registration
 *      the reducer drops is an eternally-spinning card),
 *   2. project it back out via `messageTypeDefinitionsFromChannelView`,
 *   3. lint the renderer source for self-containment (no build-service
 *      imports at render time),
 *   4. compile the renderer with `loadImport` rigged to throw — proving the
 *      module is satisfiable from host modules + declared imports alone —
 *      and assert it exports a default component.
 *
 * Agent packages that register renderers should run this in their own test
 * suite so the check travels with the renderer implementation.
 */

import {
  AGENTIC_EVENT_PAYLOAD_KIND,
  AGENTIC_PROTOCOL_VERSION,
  createInitialChannelViewState,
  reduceChannelView,
  type ChannelEnvelope,
} from "@workspace/agentic-protocol";
import { messageTypeDefinitionsFromChannelView } from "./channel-chat-merge.js";
import { compileMessageTypeModule } from "./custom-message-types.js";
import { DEFAULT_HOST_MODULES, lintRendererSource } from "./renderer-lint.js";

export interface MessageTypeDoctorSpec {
  typeId: string;
  displayMode: "inline" | "row";
  source: { type: "file"; path: string } | { type: "code"; code: string };
  imports?: Record<string, string>;
  stateSchema?: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
}

export interface MessageTypeDoctorOptions {
  /** Resolve a `file`-type source (and relative imports) to its contents. */
  loadSourceFile: (path: string) => Promise<string>;
  /** Host-exposed modules; defaults to the chat panel's exposeModules. */
  hostModules?: readonly string[];
}

export interface MessageTypeDoctorIssue {
  typeId: string;
  stage: "registration" | "projection" | "lint" | "compile";
  message: string;
}

/**
 * Install the host module map + require shim a panel provides, from modules
 * the TEST imports (so this package stays dependency-clean):
 *
 *   installDoctorHostModules({
 *     react: await import("react"),
 *     "react/jsx-runtime": await import("react/jsx-runtime"),
 *     ...
 *   });
 */
export function installDoctorHostModules(modules: Record<string, unknown>): void {
  const globals = globalThis as Record<string, unknown>;
  const map: Record<string, unknown> =
    (globals["__vibestudioModuleMap__"] as Record<string, unknown>) ?? {};
  for (const [specifier, mod] of Object.entries(modules)) map[specifier] = mod;
  globals["__vibestudioModuleMap__"] = map;
  globals["__vibestudioRequire__"] ??= (id: string) => {
    const mod = map[id];
    if (mod) return mod;
    throw new Error(`Module "${id}" not available in doctor host module map`);
  };
}

export async function runMessageTypeDoctor(
  specs: readonly MessageTypeDoctorSpec[],
  opts: MessageTypeDoctorOptions
): Promise<MessageTypeDoctorIssue[]> {
  const issues: MessageTypeDoctorIssue[] = [];

  // 1+2: registration events through the real channel reducer + projection.
  let view = createInitialChannelViewState();
  specs.forEach((spec, index) => {
    view = reduceChannelView(view, registrationEnvelope(spec, index + 1));
  });
  for (const [envelopeId, error] of Object.entries(view.ignoredEnvelopeErrors)) {
    const index = Number(envelopeId.replace("doctor-env-", "")) - 1;
    issues.push({
      typeId: specs[index]?.typeId ?? envelopeId,
      stage: "registration",
      message: `registration event rejected by the channel reducer: ${error}`,
    });
  }
  const definitions = new Map(
    messageTypeDefinitionsFromChannelView(view).map((definition) => [definition.typeId, definition])
  );

  for (const spec of specs) {
    const definition = definitions.get(spec.typeId);
    if (!definition || definition.cleared || !definition.source) {
      if (!issues.some((issue) => issue.typeId === spec.typeId)) {
        issues.push({
          typeId: spec.typeId,
          stage: "projection",
          message: "registration did not project into a usable definition",
        });
      }
      continue;
    }

    // 3: source loading + lint.
    let code: string;
    try {
      code =
        definition.source.type === "file"
          ? await opts.loadSourceFile(definition.source.path)
          : definition.source.code;
    } catch (err) {
      issues.push({
        typeId: spec.typeId,
        stage: "lint",
        message: `source unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }
    for (const issue of lintRendererSource(code, {
      imports: definition.imports,
      hostModules: opts.hostModules ?? DEFAULT_HOST_MODULES,
    })) {
      issues.push({ typeId: spec.typeId, stage: "lint", message: issue.message });
    }

    // 4: compile with the build service forbidden.
    const buildServiceCalls: string[] = [];
    const result = await compileMessageTypeModule(code, {
      imports: definition.imports,
      sourcePath: definition.source.type === "file" ? definition.source.path : undefined,
      loadSourceFile: opts.loadSourceFile,
      loadImport: async (specifier: string) => {
        buildServiceCalls.push(specifier);
        throw new Error(`build service required for "${specifier}"`);
      },
    });
    for (const specifier of buildServiceCalls) {
      issues.push({
        typeId: spec.typeId,
        stage: "compile",
        message: `compile needed a build-service import for "${specifier}" — renderer is not self-contained`,
      });
    }
    if (!result.success) {
      issues.push({
        typeId: spec.typeId,
        stage: "compile",
        message: result.error ?? "compile failed",
      });
    } else if (typeof result.module?.["default"] !== "function") {
      issues.push({
        typeId: spec.typeId,
        stage: "compile",
        message: "module has no default component export",
      });
    }
  }
  return issues;
}

/** Test-friendly wrapper: throws one aggregated error listing every issue. */
export async function assertMessageTypesHealthy(
  specs: readonly MessageTypeDoctorSpec[],
  opts: MessageTypeDoctorOptions
): Promise<void> {
  const issues = await runMessageTypeDoctor(specs, opts);
  if (issues.length > 0) {
    throw new Error(
      `Message-type doctor found ${issues.length} issue(s):\n` +
        issues.map((issue) => `- [${issue.typeId}/${issue.stage}] ${issue.message}`).join("\n")
    );
  }
}

function registrationEnvelope(spec: MessageTypeDoctorSpec, seq: number): ChannelEnvelope {
  return {
    envelopeId: `doctor-env-${seq}`,
    channelId: "doctor-channel",
    seq,
    from: { kind: "agent", id: "doctor-agent", participantId: "doctor-agent" },
    contentClass: "internal",
    externalKeys: [],
    payloadKind: AGENTIC_EVENT_PAYLOAD_KIND,
    payload: {
      kind: "messageType.registered",
      actor: { kind: "agent", id: "doctor-agent" },
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: spec.typeId,
        displayMode: spec.displayMode,
        source: spec.source,
        ...(spec.imports ? { imports: spec.imports } : {}),
        ...(spec.stateSchema ? { stateSchema: spec.stateSchema } : {}),
        ...(spec.updateSchema ? { updateSchema: spec.updateSchema } : {}),
        registeredBy: { kind: "agent", id: "doctor-agent" },
      },
      createdAt: new Date().toISOString(),
    },
    publishedAt: new Date().toISOString(),
  } as unknown as ChannelEnvelope;
}
