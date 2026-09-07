/**
 * `panel_describe` — a configurable panel resource tool for AiChatWorker.
 *
 * This is a thin wrapper over the host `panelContext.describe` RPC. The model
 * can use it whenever current panel identity or presentation state matters,
 * including after another tool has changed the panel.
 *
 * The snapshot deliberately reports absent facts as absent. This tool formats
 * them that way too — an agent told "console counts require the panel_console
 * tool" asks for the tool; an agent told "0 errors" stops looking.
 */

import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type { PanelContextSnapshot } from "@vibestudio/service-schemas/panelContext";

const panelDescribeParameters = Type.Object(
  {
    panelId: Type.Optional(
      Type.String({
        description:
          "Panel slot id to describe. Omit to describe the panel this conversation is attached to.",
      }),
    ),
  },
  { additionalProperties: false },
);

export type PanelDescribeParams = Static<typeof panelDescribeParameters>;

/** Render a snapshot as the `<panel-context>` block of §5.1. */
export function formatPanelContext(snapshot: PanelContextSnapshot): string {
  const lines: string[] = [];
  lines.push(
    "relationship: panel the user was viewing when they opened this Quickfire conversation; it may be the subject of their request",
  );
  lines.push(`slot: ${snapshot.tree.slotId}`);
  lines.push(`title: ${snapshot.tree.title ?? "(untitled)"}`);
  lines.push(`source: ${snapshot.source.source}`);
  lines.push(
    `repo: ${snapshot.source.repoPath}@${snapshot.source.effectiveVersion || "(no build)"}`,
  );
  lines.push(`kind: ${snapshot.source.kind}`);
  lines.push(`context: ${snapshot.source.contextId}`);
  lines.push(`entity: ${snapshot.source.entityId}`);
  if (snapshot.tree.stateArgs)
    lines.push(`stateArgs: ${snapshot.tree.stateArgs}`);
  const presentation = snapshot.presentation;
  lines.push(
    `lease: ${presentation.state} · ${presentation.surface ?? "no host"}` +
      ` · ${presentation.reachable ? "reachable" : "unreachable"}` +
      ` · ${presentation.supportsCdp ? "cdp-capable" : "no cdp"}`,
  );
  lines.push(`url: ${presentation.url ?? "(none reported)"}`);
  lines.push(
    snapshot.console.available
      ? `console: ${snapshot.console.errors} errors, ${snapshot.console.warnings} warnings, ${snapshot.console.entries} entries`
      : `console: unknown from here — read it with the ${snapshot.console.via} tool`,
  );
  lines.push(
    snapshot.address.available
      ? `address: ${snapshot.address.displayAddress ?? "(none)"}` +
          ` · back=${snapshot.address.canGoBack} forward=${snapshot.address.canGoForward}`
      : `address/favicon/history: unavailable (${snapshot.address.reason})`,
  );
  const siblings = snapshot.tree.siblings
    .map((sibling) => sibling.title ?? sibling.slotId)
    .join(", ");
  lines.push(`open siblings: ${siblings || "(none)"}`);
  return `<panel-context>\n${lines.join("\n")}\n</panel-context>`;
}
export function createPanelDescribeTool(
  callMain: <T>(method: string, args: unknown[]) => Promise<T>,
  boundPanelId: string,
): AgentTool<typeof panelDescribeParameters> {
  return {
    name: "panel_describe",
    label: "describe panel",
    description:
      "Re-read the panel you are attached to (or another open panel by slot id): its title, tree position and open siblings, the code identity currently occupying it, and its presentation lease. Facts this host cannot see — console counts, favicon, editable address, back/forward state — are reported as explicitly unavailable rather than guessed; use the dedicated tool named in the reply to read those.",
    parameters: panelDescribeParameters,
    execute: async (
      _toolCallId,
      params: PanelDescribeParams,
    ): Promise<AgentToolResult<PanelContextSnapshot | null>> => {
      const panelId = params.panelId ?? boundPanelId;
      const snapshot = await callMain<PanelContextSnapshot>(
        "panelContext.describe",
        [panelId],
      );
      return {
        content: [{ type: "text", text: formatPanelContext(snapshot) }],
        details: snapshot,
      };
    },
  };
}
