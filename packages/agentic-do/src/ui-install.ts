/**
 * installMessageTypes — register an agent's custom card UI on a channel.
 *
 * Every card-emitting agent repeats the same registration dance: lint the
 * renderer sources, tombstone retired type ids, publish a
 * `messageType.registered` event per card type (idempotent per install
 * version), optionally pin an action bar, and invalidate CardManager's type
 * cache. Extracted from the gmail agent's installChannelUi so new agents
 * declare their card specs and call one helper.
 */

import {
  AGENTIC_PROTOCOL_VERSION,
  type ActorRef,
  type AgenticEvent,
  type CustomMessageDisplayMode,
} from "@workspace/agentic-protocol";
import { lintRendererSource } from "@workspace/agentic-core";
import type { ChannelClient } from "./channel-client.js";
import type { CardManager } from "./custom-cards.js";

export interface MessageTypeSpec {
  typeId: string;
  displayMode: CustomMessageDisplayMode;
  /** Workspace-relative renderer path, e.g. "panels/news/renderers/news-briefing.tsx". */
  path: string;
  stateSchema: Record<string, unknown>;
  updateSchema?: Record<string, unknown>;
}

export interface ActionBarSpec {
  id: string;
  /** Workspace-relative source path. */
  path: string;
  maxHeight?: number;
}

export interface InstallMessageTypesOptions {
  channel: ChannelClient;
  /** Publishing actor (the agent's channel participant identity). */
  actor: ActorRef & { participantId?: string; metadata?: Record<string, unknown> };
  specs: readonly MessageTypeSpec[];
  /** Module map the panel can satisfy self-contained (e.g. radix themes/icons + react). */
  imports: Record<string, string>;
  /**
   * Bump to re-publish registrations after changing specs/renderers; the
   * version is baked into the idempotency keys.
   */
  version: number;
  /** Idempotency-key namespace, e.g. "news" — keep stable per agent. */
  keyPrefix: string;
  /** Previously-used type ids to tombstone so stale cards stop rendering. */
  retiredTypeIds?: readonly string[];
  actionBar?: ActionBarSpec;
  /** CardManager whose per-type caches must be invalidated on (re)install. */
  cards?: CardManager;
  channelId?: string;
  /**
   * Read a workspace file for renderer linting. Return null when unreadable —
   * lint is then skipped for that file (a transient fs problem must not block
   * UI install; the panel reads the file itself at compile time).
   */
  readFile: (path: string) => Promise<string | null>;
}

/**
 * Lint renderer sources, then publish messageType.cleared tombstones,
 * messageType.registered events, and the optional action bar. Throws (and
 * publishes nothing) when a renderer has a value import the panel cannot
 * satisfy self-contained — at render time that becomes a stuck card with no
 * attribution.
 */
export async function installMessageTypes(options: InstallMessageTypesOptions): Promise<void> {
  const { channel, actor, specs, imports, version, keyPrefix } = options;

  await lintSources(options);

  for (const typeId of options.retiredTypeIds ?? []) {
    const event: AgenticEvent<"messageType.cleared"> = {
      kind: "messageType.cleared",
      actor,
      payload: { protocol: AGENTIC_PROTOCOL_VERSION, typeId },
      createdAt: new Date().toISOString(),
    };
    await channel.publishAgenticEvent(actor.id, event, {
      idempotencyKey: `${keyPrefix}:ui:v${version}:message-type-cleared:${typeId}`,
      senderMetadata: actor.metadata,
    });
    if (options.cards && options.channelId) options.cards.invalidateType(options.channelId, typeId);
  }

  for (const spec of specs) {
    const event: AgenticEvent<"messageType.registered"> = {
      kind: "messageType.registered",
      actor,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        typeId: spec.typeId,
        displayMode: spec.displayMode,
        source: { type: "file", path: spec.path },
        imports,
        stateSchema: spec.stateSchema,
        ...(spec.updateSchema ? { updateSchema: spec.updateSchema } : {}),
        registeredBy: actor,
      },
      createdAt: new Date().toISOString(),
    };
    await channel.publishAgenticEvent(actor.id, event, {
      idempotencyKey: `${keyPrefix}:ui:v${version}:message-type:${spec.typeId}`,
      senderMetadata: actor.metadata,
    });
    if (options.cards && options.channelId) {
      options.cards.invalidateType(options.channelId, spec.typeId);
    }
  }

  if (options.actionBar) {
    const event: AgenticEvent<"ui.action_bar.updated"> = {
      kind: "ui.action_bar.updated",
      actor,
      payload: {
        protocol: AGENTIC_PROTOCOL_VERSION,
        uiType: "action_bar",
        id: options.actionBar.id,
        source: { type: "file", path: options.actionBar.path },
        imports,
        ...(options.actionBar.maxHeight !== undefined
          ? { maxHeight: options.actionBar.maxHeight }
          : {}),
        result: { ok: true },
      },
      createdAt: new Date().toISOString(),
    };
    await channel.publishAgenticEvent(actor.id, event, {
      idempotencyKey: `${keyPrefix}:ui:v${version}:action-bar`,
      senderMetadata: actor.metadata,
    });
  }
}

async function lintSources(options: InstallMessageTypesOptions): Promise<void> {
  const paths = [
    ...options.specs.map((spec) => spec.path),
    ...(options.actionBar ? [options.actionBar.path] : []),
  ];
  const failures: string[] = [];
  for (const path of paths) {
    const code = await options.readFile(path);
    if (code === null) {
      console.warn(`[installMessageTypes] renderer lint skipped (unreadable): ${path}`);
      continue;
    }
    for (const issue of lintRendererSource(code, { imports: options.imports })) {
      failures.push(`${path}: ${issue.message}`);
    }
  }
  if (failures.length > 0) {
    throw new Error(`Renderer registration blocked:\n${failures.join("\n")}`);
  }
}
