/**
 * Typed mutation surface for context-local workspace services.
 *
 * A service declaration and its optional singleton are one semantic edit. This
 * keeps agents out of brittle YAML splicing and validates the complete candidate
 * before it can become the context's working state.
 */

import { Type } from "@sinclair/typebox";
import type { AgentTool, AgentToolResult } from "@workspace/pi-core";
import type { VcsWorkingMutationResult } from "@vibestudio/service-schemas/vcs";
import YAML from "yaml";
import { generateDiffString } from "./edit-diff.js";
import { resolveToolFile } from "../semantic-file-resolution.js";
import {
  resolveToolWorkingState,
  toolCommandId,
  toolContextId,
  type ToolEditingVcs,
  type ToolMutationContext,
} from "./tool-vcs.js";

const principalSchema = Type.Union([
  Type.Literal("host"),
  Type.Literal("user"),
  Type.Literal("code"),
  Type.Literal("session"),
  Type.Literal("mission"),
]);

const workspaceServiceSchema = Type.Union(
  [
    Type.Object(
      {
        operation: Type.Literal("upsert"),
        name: Type.String({ description: "Stable service name to add or update." }),
        source: Type.String({
          description: "Provider worker source, e.g. workers/todo-store.",
        }),
        title: Type.String({ description: "User-facing service title." }),
        action: Type.String({
          description: 'User-facing verb phrase completing "Allow … to …".',
        }),
        description: Type.String({ description: "Plain-language purpose of the service." }),
        notability: Type.Union([Type.Literal("headline"), Type.Literal("everyday")], {
          description:
            "Use headline when a non-technical person would want to know before adding a caller; everyday for ordinary workspace machinery.",
        }),
        presentation: Type.Object(
          {
            domain: Type.Union([
              Type.Literal("files"),
              Type.Literal("sharing"),
              Type.Literal("accounts"),
              Type.Literal("web"),
              Type.Literal("automation"),
              Type.Literal("people"),
              Type.Literal("computer"),
            ]),
            verb: Type.Union([Type.Literal("see"), Type.Literal("act"), Type.Literal("manage")]),
            substanceKind: Type.Optional(
              Type.Union([
                Type.Literal("change-set"),
                Type.Literal("send"),
                Type.Literal("deletion"),
                Type.Literal("custom"),
              ])
            ),
          },
          {
            additionalProperties: false,
            description:
              "How authority prompts describe the service. Sharing requires substanceKind.",
          }
        ),
        protocols: Type.Array(Type.String(), {
          minItems: 1,
          uniqueItems: true,
          description: "Stable protocols accepted by workers.resolveService().",
        }),
        principals: Type.Array(principalSchema, {
          minItems: 1,
          uniqueItems: true,
          description: "Authenticated principal kinds allowed by the service declaration.",
        }),
        transport: Type.Union([
          Type.Object(
            {
              kind: Type.Literal("durable-object"),
              className: Type.String(),
              objectKey: Type.Optional(
                Type.String({
                  description:
                    "When present, atomically declares this default singleton object key too.",
                })
              ),
            },
            { additionalProperties: false }
          ),
          Type.Object(
            {
              kind: Type.Literal("worker"),
              routePath: Type.String(),
            },
            { additionalProperties: false }
          ),
        ]),
      },
      {
        additionalProperties: false,
        description:
          "Add or replace one complete context-local service declaration. All declaration metadata is required.",
      }
    ),
    Type.Object(
      {
        operation: Type.Literal("remove"),
        name: Type.String({ description: "Stable service name to remove." }),
        removeSingleton: Type.Optional(
          Type.Boolean({
            description:
              "Also remove the matching singleton when no remaining service uses its provider class.",
          })
        ),
      },
      { additionalProperties: false }
    ),
  ],
  {
    description:
      "Use operation=upsert with the complete declaration, or operation=remove with its stable name.",
  }
);

export type WorkspaceServiceToolInput =
  | {
      operation: "upsert";
      name: string;
      source: string;
      title: string;
      action: string;
      description: string;
      notability: "headline" | "everyday";
      presentation: {
        domain: "files" | "sharing" | "accounts" | "web" | "automation" | "people" | "computer";
        verb: "see" | "act" | "manage";
        substanceKind?: "change-set" | "send" | "deletion" | "custom";
      };
      protocols: string[];
      principals: Array<"host" | "user" | "code" | "session" | "mission">;
      transport:
        | { kind: "durable-object"; className: string; objectKey?: string }
        | { kind: "worker"; routePath: string };
    }
  | {
      operation: "remove";
      name: string;
      removeSingleton?: boolean;
    };

interface ServiceDeclaration {
  source: string;
  name: string;
  title?: string;
  action?: string;
  description?: string;
  notability?: "headline" | "everyday";
  presentation: {
    domain: "files" | "sharing" | "accounts" | "web" | "automation" | "people" | "computer";
    verb: "see" | "act" | "manage";
    substanceKind?: "change-set" | "send" | "deletion" | "custom";
  };
  protocols?: string[];
  authority: { principals: Array<"host" | "user" | "code" | "session" | "mission"> };
  durableObject?: { className: string };
  worker?: { routePath: string };
}

interface SingletonDeclaration {
  source: string;
  className: string;
  key: string;
  contextId?: string;
}

interface WorkspaceConfigDocument {
  services?: ServiceDeclaration[];
  singletonObjects?: SingletonDeclaration[];
  [key: string]: unknown;
}

export interface WorkspaceServiceToolDetails {
  changed: boolean;
  operation: "upsert" | "remove";
  serviceName: string;
  docsId?: string;
  diff: string;
  diagnostic?: "not-found" | "singleton-still-used";
  vcsResult?: VcsWorkingMutationResult;
}

export interface WorkspaceServiceToolDeps {
  validateConfig(content: string): Promise<void>;
}

function isServiceDeclaration(value: unknown): value is ServiceDeclaration {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { source?: unknown }).source === "string" &&
    typeof (value as { name?: unknown }).name === "string"
  );
}

function isSingletonDeclaration(value: unknown): value is SingletonDeclaration {
  return Boolean(
    value &&
    typeof value === "object" &&
    typeof (value as { source?: unknown }).source === "string" &&
    typeof (value as { className?: unknown }).className === "string" &&
    typeof (value as { key?: unknown }).key === "string"
  );
}

export function createWorkspaceServiceTool(
  vcs: ToolEditingVcs,
  context: ToolMutationContext,
  deps: WorkspaceServiceToolDeps
): AgentTool<typeof workspaceServiceSchema, WorkspaceServiceToolDetails> {
  return {
    name: "workspace_service",
    label: "workspace_service",
    description:
      "Atomically add, update, or remove a live context-local service declaration in meta/vibestudio.yml. For Durable Objects, transport.objectKey declares the matching singleton in the same validated edit. Use this instead of splicing the services or singletonObjects YAML lists by hand; then confirm the live contract with docs_search/docs_open before eval.",
    parameters: workspaceServiceSchema,
    cancellationMode: "settle",
    execute: async (
      _toolCallId,
      input,
      signal
    ): Promise<AgentToolResult<WorkspaceServiceToolDetails>> => {
      if (signal?.aborted) throw new Error("Operation aborted");
      // AgentTool invokes execute only after validating the discriminated
      // TypeBox union. Keep the implementation on that exact public shape.
      const command = input as WorkspaceServiceToolInput;
      const operation = command.operation;
      const serviceName = command.name;
      const workingHead = await resolveToolWorkingState(vcs, context);
      const file = await resolveToolFile(vcs, workingHead, "meta/vibestudio.yml");
      if (!file || file.content.kind !== "text") {
        throw new Error("The current workspace has no text meta/vibestudio.yml document");
      }
      const sourceContent = file.content.text;
      const document = YAML.parseDocument(sourceContent);
      if (document.errors.length > 0) throw document.errors[0];
      const raw = document.toJS() as WorkspaceConfigDocument | null;
      if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("meta/vibestudio.yml must contain a configuration mapping");
      }
      const services = Array.isArray(raw.services) ? raw.services.filter(isServiceDeclaration) : [];
      const singletons = Array.isArray(raw.singletonObjects)
        ? raw.singletonObjects.filter(isSingletonDeclaration)
        : [];

      if (operation === "upsert") {
        const transport = command.transport;
        const className = "className" in transport ? transport.className : undefined;
        const routePath = "routePath" in transport ? transport.routePath : undefined;
        if (transport.kind === "durable-object" && !className) {
          throw new Error("A durable-object service requires transport.className");
        }
        if (transport.kind === "worker" && !routePath) {
          throw new Error("A worker service requires transport.routePath");
        }
        if (transport.kind !== "durable-object" && transport.kind !== "worker") {
          throw new Error('Service transport.kind must be "durable-object" or "worker"');
        }
        const source = command.source;
        const transportDeclaration =
          transport.kind === "durable-object"
            ? { durableObject: { className: className! } }
            : { worker: { routePath: routePath! } };
        const declaration: ServiceDeclaration = {
          source,
          name: serviceName,
          title: command.title,
          action: command.action,
          description: command.description,
          notability: command.notability,
          presentation: { ...command.presentation },
          protocols: [...command.protocols],
          authority: { principals: [...command.principals] },
          ...transportDeclaration,
        };
        const serviceIndex = services.findIndex(({ name }) => name === serviceName);
        if (serviceIndex >= 0) services[serviceIndex] = declaration;
        else services.push(declaration);

        if (transport.kind === "durable-object" && transport.objectKey) {
          const singleton: SingletonDeclaration = {
            source,
            className: className!,
            key: transport.objectKey,
          };
          const singletonIndex = singletons.findIndex(
            ({ source, className }) =>
              source === singleton.source && className === singleton.className
          );
          if (singletonIndex >= 0) singletons[singletonIndex] = singleton;
          else singletons.push(singleton);
        }
      } else {
        const serviceIndex = services.findIndex(({ name }) => name === serviceName);
        if (serviceIndex < 0) {
          return {
            content: [{ type: "text", text: `No service named ${serviceName} is declared.` }],
            details: {
              changed: false,
              operation: "remove",
              serviceName,
              diff: "",
              diagnostic: "not-found",
            },
          };
        }
        const [removed] = services.splice(serviceIndex, 1);
        if (command.removeSingleton && removed?.durableObject) {
          const stillUsed = services.some(
            (service) =>
              service.source === removed.source &&
              service.durableObject?.className === removed.durableObject?.className
          );
          if (stillUsed) {
            return {
              content: [
                {
                  type: "text",
                  text: `No changes made: another service still uses ${removed.source}:${removed.durableObject.className}.`,
                },
              ],
              details: {
                changed: false,
                operation: "remove",
                serviceName,
                diff: "",
                diagnostic: "singleton-still-used",
              },
            };
          }
          const singletonIndex = singletons.findIndex(
            ({ source, className }) =>
              source === removed.source && className === removed.durableObject?.className
          );
          if (singletonIndex >= 0) singletons.splice(singletonIndex, 1);
        }
      }

      document.set("services", services);
      document.set("singletonObjects", singletons);
      const candidate = String(document);
      await deps.validateConfig(candidate);
      if (signal?.aborted) throw new Error("Operation aborted");

      const vcsResult = await vcs.edit({
        contextId: toolContextId(context),
        expectedWorkingHead: workingHead,
        commandId: toolCommandId(context),
        changes: [
          {
            kind: "text-edit",
            repositoryId: file.repositoryId,
            fileId: file.fileId,
            edits: [{ start: 0, end: sourceContent.length, text: candidate }],
          },
        ],
      });
      const diff = generateDiffString(sourceContent, candidate).diff;
      const docsId = operation === "upsert" ? `workspace:${serviceName}` : undefined;
      return {
        content: [
          {
            type: "text",
            text:
              operation === "upsert"
                ? `Declared ${serviceName} and validated the complete workspace config. Open ${docsId} with docs_open before eval.`
                : `Removed ${serviceName} and validated the complete workspace config.`,
          },
        ],
        details: {
          changed: true,
          operation,
          serviceName,
          ...(docsId ? { docsId } : {}),
          diff,
          vcsResult,
        },
      };
    },
  };
}
