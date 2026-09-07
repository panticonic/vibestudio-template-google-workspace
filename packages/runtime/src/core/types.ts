/**
 * Core type definitions for Vibestudio runtime
 * Shared types for panels and workers
 */

import type { ZodType } from "zod";
import type { CdpPage } from "@workspace/cdp-client";
import type * as Rpc from "./rpc.js";
import type {
  PanelLifecycleResult,
  PanelPlacementHint,
} from "@vibestudio/shared/types";
import type { PanelTreePlacement } from "@vibestudio/shared/panel/treeIndex";
import type {
  PanelDiagnosticPacket,
  PanelConsoleHistoryLevel,
  PanelConsoleHistoryResult,
  PanelObservation,
  PanelSnapshotObservation,
} from "@vibestudio/shared/panel/observation";

export interface PanelFocusOptions {
  /** Visual placement request; omitted preserves ordinary focus behavior. */
  placement?: PanelPlacementHint;
  /** Panel to place this panel relative to; defaults to the previously focused panel. */
  anchorPanelId?: string;
  /** Cancel readiness observation without cancelling the panel lifecycle. */
  signal?: AbortSignal;
}

export interface PanelWaitOptions {
  /** Cancel readiness observation without cancelling the panel lifecycle. */
  signal?: AbortSignal;
}

// =============================================================================
// Event Schema Types (zod-based validation)
// =============================================================================

/**
 * A map of event names to their zod schemas.
 * Used for runtime validation of event payloads.
 *
 * @example
 * ```ts
 * import { z, type EventSchemaMap } from "@workspace/runtime";
 *
 * export const myEventSchemas = {
 *   "counter-changed": z.object({ value: z.number(), previousValue: z.number() }),
 *   "reset": z.object({ timestamp: z.string() }),
 * } satisfies EventSchemaMap;
 * ```
 */
export type EventSchemaMap = Record<string, ZodType>;

/**
 * Infer the event map type from an EventSchemaMap.
 * This gives you typed payloads derived from your zod schemas.
 *
 * @example
 * ```ts
 * import { z, type InferEventMap } from "@workspace/runtime";
 *
 * const schemas = {
 *   "saved": z.object({ path: z.string() }),
 * };
 *
 * type MyEvents = InferEventMap<typeof schemas>;
 * // { saved: { path: string } }
 * ```
 */
export type InferEventMap<T extends EventSchemaMap> = {
  [K in keyof T]: T[K] extends ZodType<infer U> ? U : never;
};

/**
 * Information about a panel or worker.
 */
export interface EndpointInfo {
  /** The endpoint's unique ID */
  panelId: string;
  /** Storage partition name (derived from contextId) */
  partition: string;
  /** Context ID (format: {mode}_{type}_{identifier}) */
  contextId: string;
}

// =============================================================================
// RPC Proxy Types
// =============================================================================

/**
 * Proxy type for typed RPC calls.
 * Transforms ExposedMethods into callable async functions.
 */
export type TypedCallProxy<T extends Record<string, Rpc.AnyFunction>> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

// =============================================================================
// Unified PanelHandle Types
// =============================================================================

export interface CdpEndpoint {
  wsEndpoint: string;
  token?: string;
}

export interface PanelCdpGeneration {
  protocol: "panel-cdp-generation.v1";
  panelId: string;
  attemptId: string;
  runtimeEntityId: string;
  buildKey: string | null;
}

export interface PanelCdpSession {
  readonly protocol: "panel-cdp-session.v1";
  readonly generation: PanelCdpGeneration;
  readonly page: CdpPage;
  /**
   * Re-observe the durable panel attempt. The current page is retained when
   * its generation is still active; otherwise it is closed and replaced.
   * No browser interaction is replayed.
   */
  refresh(): Promise<PanelCdpSessionRefresh>;
  close(): Promise<void>;
}

export type PanelCdpSessionRefresh =
  | { status: "current"; session: PanelCdpSession }
  | {
      status: "reconnected";
      generation: PanelCdpGeneration;
      session: PanelCdpSession;
    }
  | {
      status: "replaced";
      previousGeneration: PanelCdpGeneration;
      session: PanelCdpSession;
    };

export interface PanelScreenshotOptions {
  format?: "png" | "jpeg";
  quality?: number;
}

export interface PanelScreenshotResult {
  /** Base64-encoded image bytes. */
  data: string;
  mimeType: "image/png" | "image/jpeg";
  width: number;
  height: number;
}

export type {
  PanelConsoleHistoryEntry,
  PanelConsoleHistoryLevel,
  PanelConsoleHistoryResult,
} from "@vibestudio/shared/panel/observation";

export interface PanelConsoleHistoryOptions {
  limit?: number;
  errorLimit?: number;
  levels?: PanelConsoleHistoryLevel[];
  sources?: Array<"console" | "lifecycle">;
  contains?: string;
  since?: number;
  until?: number;
  /** Exclusive stable cursor for reading the next older page. */
  beforeSeq?: number;
}

export type PanelDiagnosticsResult = PanelDiagnosticPacket;

export interface CdpAutomation {
  /** The canonical @workspace/cdp-client automation page for this panel target. */
  page(): Promise<CdpPage>;
  /**
   * Acquire the one active page fenced to the panel's current immutable
   * runtime attempt. Concurrent and repeated acquisition reuses that session
   * until it is closed or its generation changes.
   */
  session(): Promise<PanelCdpSession>;
  /**
   * Historical console messages captured by the Electron host from panel
   * creation time. Returns `{ entries, errors, dropped, capacity }`, not an
   * array; use `result.errors` or filter `result.entries`. This is separate
   * from the live array returned by `page.consoleEvents()`.
   */
  consoleHistory(
    options?: PanelConsoleHistoryOptions,
  ): Promise<PanelConsoleHistoryResult>;
  getCdpEndpoint(): Promise<CdpEndpoint>;
  navigate(url: string): Promise<void>;
  goBack(): Promise<void>;
  goForward(): Promise<void>;
  reload(): Promise<void>;
  stop(): Promise<void>;
  click(selector: string): Promise<void>;
  /**
   * One-RPC host capture, including hidden/unslotted panels. Returning this
   * exact value from eval attaches native image content without filesystem IO.
   */
  screenshot(options?: PanelScreenshotOptions): Promise<PanelScreenshotResult>;
}

export type PanelHandleContractRole = "parent" | "child";

export interface PanelNavigateOptions {
  contextId?: string;
  env?: Record<string, string>;
  ref?: string;
  stateArgs?: Record<string, unknown>;
  /** Cancel readiness observation after the navigation has committed. */
  signal?: AbortSignal;
}

export interface PanelSetTitleOptions {
  /**
   * Preserve this semantic/user-chosen title across inferred document-title
   * updates from the hosted page.
   */
  explicit?: boolean;
}

/**
 * Unified handle for communicating with any panel-tree member.
 * Parent helpers return this same handle type.
 *
 * @typeParam T - RPC methods exposed by the target (what this caller can call)
 * @typeParam E - RPC event map for events from the target (what this caller can listen to)
 * @typeParam EmitE - RPC event map for events to the target (what this caller emits)
 *
 * @example
 * ```ts
 * // For full type safety, prefer getParentWithContract():
 * import { myContract } from "./contract.js";
 * const parent = getParentWithContract(myContract);
 * if (parent) {
 *   await parent.emit("saved", { path: "/foo.txt" }); // Typed from contract!
 * }
 *
 * // Or use direct type parameters:
 * interface MyEmitEvents { saved: { path: string } }
 * const parent = getParent<{}, {}, MyEmitEvents>();
 * parent?.emit("saved", { path: "/foo.txt" }); // Typed!
 * ```
 */
export interface PanelHandle<
  T extends Record<string, Rpc.AnyFunction> = Rpc.ExposedMethods,
  E extends Rpc.RpcEventMap = Rpc.RpcEventMap,
  EmitE extends Rpc.RpcEventMap = Rpc.RpcEventMap,
> {
  /** Stable panel slot ID. CDP/control use this slot; RPC resolves the current runtime entity. */
  readonly id: string;
  /** Last observed title. Use observe() for authoritative lifecycle state. */
  readonly title: string;
  /** Last known source. Browser URLs are exposed without the internal browser: prefix. */
  readonly source: string;
  readonly kind: "workspace" | "browser";
  readonly parentId: string | null;

  /**
   * Canonical, cheap lifecycle read for the current immutable runtime attempt.
   * This is the only status surface: phase "ready" means host navigation and
   * the application boot handshake both completed.
   */
  observe(): Promise<PanelObservation>;

  /**
   * Typed RPC call proxy for methods the target chose to expose.
   * @example handle.call.notifyReady()
   */
  readonly call: TypedCallProxy<T>;

  /** Chrome DevTools Protocol automation for this panel. */
  readonly cdp: CdpAutomation;

  /**
   * Convenience wrapper for `handle.cdp.click(selector)`.
   * Useful when the handle itself is the target panel being automated.
   */
  click(selector: string): Promise<void>;

  readonly stateArgs: {
    get<TState = Record<string, unknown>>(): Promise<TState>;
    /** Merge a patch; use null to remove a key. Returns the full resulting state. */
    set<TState = Record<string, unknown>>(
      updates: Record<string, unknown>,
    ): Promise<TState>;
  };

  /**
   * Emit a typed event to the target.
   * @example handle.emit("saved", { path: "/foo.txt" })
   */
  emit<EventName extends Extract<keyof EmitE, string>>(
    event: EventName,
    payload: EmitE[EventName],
  ): Promise<void>;

  /**
   * Emit an event to the target panel (untyped fallback).
   * @example handle.emit("status", { ready: true })
   */
  emit(event: string, payload: unknown): Promise<void>;

  /**
   * Listen for events from the target panel (typed if event map provided).
   * @returns Unsubscribe function
   */
  on<EventName extends Extract<keyof E, string>>(
    event: EventName,
    listener: (payload: E[EventName]) => void,
  ): () => void;

  /**
   * Listen for events from the target panel (untyped fallback).
   * @returns Unsubscribe function
   */
  on(event: string, listener: (payload: unknown) => void): () => void;

  withContract<C extends PanelContract, Role extends PanelHandleContractRole>(
    contract: C,
    role: Role,
  ): PanelHandleFromContract<C, Role>;

  parent(): PanelHandle | null;
  navigate(
    source: string,
    options?: PanelNavigateOptions,
  ): Promise<PanelObservation>;
  reload(options?: PanelWaitOptions): Promise<PanelObservation>;
  /** One bounded post-mortem packet: observation, console history, and ready document. */
  diagnose(): Promise<PanelDiagnosticsResult>;
  /** Durably archive this panel and its subtree, retiring their live runtimes. */
  archive(): Promise<PanelLifecycleResult>;
  unload(): Promise<PanelLifecycleResult>;
  /** Set this slot's display title without loading its runtime. */
  setTitle(title: string, options?: PanelSetTitleOptions): Promise<void>;
  movePanel(
    newParentId: string | null,
    placement?: PanelTreePlacement,
  ): Promise<void>;
  takeOver(): Promise<void>;
  openDevTools(mode?: "detach" | "right" | "bottom"): Promise<void>;
  /** Transactionally prepare and activate a new immutable attempt from source. */
  rebuild(options?: PanelWaitOptions): Promise<PanelObservation>;
  focus(options?: PanelFocusOptions): Promise<PanelObservation>;
  snapshot(options?: PanelWaitOptions): Promise<PanelSnapshotObservation>;
  tree(): Promise<unknown>;
  state(): Promise<unknown>;
  routes(): Promise<unknown>;
  setMode(mode: "fixture" | "live"): Promise<unknown>;
}

// =============================================================================
// Contract Types (for typed parent↔child communication)
// =============================================================================

/**
 * One side of a panel contract (child or parent).
 */
export interface ContractSide<
  Methods extends Record<string, Rpc.AnyFunction> = Rpc.ExposedMethods,
  Emits extends EventSchemaMap = EventSchemaMap,
> {
  readonly methods?: Methods;
  readonly emits?: Emits;
}

/**
 * A typed contract between a parent and child panel.
 * Defines RPC methods and events for both sides.
 */
export interface PanelContract<
  ChildMethods extends Record<string, Rpc.AnyFunction> = Rpc.ExposedMethods,
  ChildEmits extends EventSchemaMap = EventSchemaMap,
  ParentMethods extends Record<string, Rpc.AnyFunction> = Rpc.ExposedMethods,
  ParentEmits extends EventSchemaMap = EventSchemaMap,
> {
  readonly source: string;
  readonly child?: ContractSide<ChildMethods, ChildEmits>;
  readonly parent?: ContractSide<ParentMethods, ParentEmits>;
  readonly __brand?: "PanelContract";
}

/**
 * Extract a typed PanelHandle from a contract for one side of the relationship.
 */
export type PanelHandleFromContract<
  C extends PanelContract,
  Role extends PanelHandleContractRole,
> =
  C extends PanelContract<
    infer _ChildMethods,
    infer ChildEmits,
    infer ParentMethods,
    infer ParentEmits
  >
    ? Role extends "parent"
      ? PanelHandle<
          ParentMethods,
          InferEventMap<ParentEmits>,
          InferEventMap<ChildEmits>
        >
      : PanelHandle<
          _ChildMethods,
          InferEventMap<ChildEmits>,
          InferEventMap<ParentEmits>
        >
    : never;

// =============================================================================
// Workspace Discovery Types (for workspace units and launchable panels)
// =============================================================================

/**
 * A node in the workspace tree.
 * Folders contain children, workspace units are leaves (children = []).
 */
export interface WorkspaceNode {
  /** Directory or unit name. */
  name: string;
  /**
   * Relative path from workspace root using forward slashes.
   * Example: "panels/editor"
   */
  path: string;
  /** True if this directory is a workspace unit root. */
  isUnit: boolean;
  /**
   * If this is a launchable panel/worker (has vibestudio config).
   * Note: We intentionally include entries even if some fields are missing
   * (e.g., no title) - better to show them in the UI and let panelBuilder
   * report the real error than to silently hide repos with incomplete configs.
   */
  launchable?: {
    type: "app";
    title: string;
    description?: string;
    icon?: string;
    hidden?: boolean;
  };
  /**
   * Package metadata if this unit has a package.json with a name.
   */
  packageInfo?: {
    name: string;
    version?: string;
  };
  /**
   * Skill metadata if this unit has a SKILL.md file with YAML frontmatter.
   */
  skillInfo?: {
    name: string;
    description: string;
  };
  /** Child nodes (empty for workspace units since they're leaves). */
  children: WorkspaceNode[];
}

/**
 * Complete workspace tree with root-level children.
 */
export interface WorkspaceTree {
  /** Root children (top-level directories) */
  children: WorkspaceNode[];
}
