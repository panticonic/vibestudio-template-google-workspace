import { canonicalJson } from "@vibestudio/content-addressing";
import type { TemplateAuthoringIntent, TemplateCatalogSnapshot as ServiceCatalog, TemplateLocator, TemplatePublication } from "@vibestudio/service-schemas/templates";
import { parseTemplateManifestContent, rootRuntimeFromTemplateManifest, validateTemplateSnapshotInventory } from "@vibestudio/workspace/templateManifest";
import { TEMPLATE_SOURCE_MANIFEST_PATH, canonicalTemplateNodeId } from "@vibestudio/workspace/templateCoordinates";
import { WorkspaceConfigSchema, WorkspaceTemplatePinSchema } from "@vibestudio/workspace-contracts/workspaceConfigSchema";
import { parseTemplateRegistry, TemplateRegistryUnavailableError } from "@workspace/template-registry";
import YAML from "yaml";
import type { ExtensionContextLike } from "./context.js";
import { inspectTemplateAuthoring, listTemplateAuthoringParts } from "./authoring.js";
import { observeWorkspace } from "./workspace.js";
import { retainedInspectionPin } from "./inspectionPin.js";
import { acquireTemplateSnapshot, catalogPin, createRegistryClient, discoverDirectTemplatePin } from "./source.js";

async function catalog(ctx: ExtensionContextLike, refresh = false) {
  const info = await ctx.workspace.getInfo();
  const config = WorkspaceConfigSchema.parse(info.config);
  const source = config.templateRegistry;
  if (!source) return null;
  const client = await createRegistryClient(ctx, {
    statePath: ctx.storage.root,
    systemEpoch: config.systemEpoch,
    registry: source,
  });
  if (refresh) return client.refresh();
  try {
    return await client.catalog();
  } catch (error) {
    if (error instanceof TemplateRegistryUnavailableError) return null;
    throw error;
  }
}

export async function resolveInspectionPin(
  ctx: ExtensionContextLike,
  locator: TemplateLocator,
) {
  const retained = retainedInspectionPin(locator);
  if (retained) return WorkspaceTemplatePinSchema.parse(retained);
  if ("catalogId" in locator) {
    const snapshot = await catalog(ctx);
    if (!snapshot) throw new Error("No verified template catalog is cached");
    return catalogPin(snapshot, locator.catalogId, locator.registryCommit, locator.registrySnapshot);
  }
  if ("url" in locator) return discoverDirectTemplatePin(ctx, ctx.storage.root, locator);
  throw new Error("Unsupported template locator");
}

async function inspect(ctx: ExtensionContextLike, locator: TemplateLocator) {
  const info = await ctx.workspace.getInfo();
  const config = WorkspaceConfigSchema.parse(info.config);
  const pin = await resolveInspectionPin(ctx, locator);
  const snapshot = await acquireTemplateSnapshot(ctx, ctx.storage.root, pin, canonicalTemplateNodeId(pin.url, pin.commit));
  const bytes = snapshot.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
  if (!bytes) throw new Error(`Upstream snapshot is missing ${TEMPLATE_SOURCE_MANIFEST_PATH}`);
  const manifest = parseTemplateManifestContent(Buffer.from(bytes).toString("utf8"), config.systemEpoch);
  rootRuntimeFromTemplateManifest(manifest);
  const paths = snapshot.files.map((file) => file.path);
  validateTemplateSnapshotInventory(manifest.inventory, paths);
  return {
    pin,
    ...(manifest.presentation ? { presentation: manifest.presentation } : {}),
    repositories: manifest.inventory.repositories,
    files: manifest.inventory.files,
  };
}

async function verifyPublication(ctx: ExtensionContextLike, publication: TemplatePublication, credential?: string) {
  const pin = WorkspaceTemplatePinSchema.parse({
    url: publication.templateUrl,
    ref: publication.ref,
    commit: publication.commit,
    snapshot: publication.snapshot,
    ...(credential ? { credential } : {}),
  });
  const snapshot = await acquireTemplateSnapshot(ctx, ctx.storage.root, pin, canonicalTemplateNodeId(pin.url, pin.commit));
  const bytes = snapshot.readFile(TEMPLATE_SOURCE_MANIFEST_PATH);
  if (!bytes) throw new Error(`Published snapshot is missing ${TEMPLATE_SOURCE_MANIFEST_PATH}`);
  const info = await ctx.workspace.getInfo();
  const config = WorkspaceConfigSchema.parse(info.config);
  const manifest = parseTemplateManifestContent(Buffer.from(bytes).toString("utf8"), config.systemEpoch);
  rootRuntimeFromTemplateManifest(manifest);
  validateTemplateSnapshotInventory(manifest.inventory, snapshot.files.map((file) => file.path));
}

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("templates activating");
  return {
    catalog: (options: { refresh?: boolean } = {}) => catalog(ctx, options.refresh === true),
    inspect: (locator: TemplateLocator) => inspect(ctx, locator),
    inspectAuthoring: async (input: TemplateAuthoringIntent) =>
      inspectTemplateAuthoring(ctx, await observeWorkspace(ctx), input),
    authoringParts: async () => listTemplateAuthoringParts(ctx, await observeWorkspace(ctx)),
    async publishAuthoring(input: {
      commandId: string; intent: TemplateAuthoringIntent; expectedFingerprint: string; version: string;
      destination: { provider: string; owner: string; name: string }; credentialId?: string;
      creation?: { private?: boolean; description?: string };
    }) {
      const observation = await observeWorkspace(ctx);
      const current = await inspectTemplateAuthoring(ctx, observation, input.intent);
      if (current.fingerprint !== input.expectedFingerprint) throw new Error("Workspace source changed after inspection; inspect authoring again");
      return ctx.extensions.invoke<TemplatePublication>("@workspace-extensions/git-bridge", "publishTemplate", [{
        operationId: input.commandId, expectedMainEventId: current.mainEventId, templateName: current.request.name,
        version: input.version, manifest: current.manifest, manifestDigest: current.manifestDigest,
        parts: current.includedParts.map((repoPath) => ({ repoPath, subdir: repoPath })),
        destination: input.destination, ...(input.credentialId ? { credentialId: input.credentialId } : {}),
        creation: { private: input.creation?.private ?? true, description: input.creation?.description ?? input.intent.description },
      }]);
    },
    async suggestRegistryEntry(input: {
      commandId: string; catalog: ServiceCatalog; publication: TemplatePublication; credential?: string;
      entry: { id: string; name: string; description: string; tags: string[]; recommended: boolean }; revision: string;
    }) {
      const current = await catalog(ctx, true);
      if (!current || input.catalog.stale || input.catalog.source !== "verified") throw new Error("Refresh the template registry before preparing a contribution");
      const reviewed = { version: input.catalog.version, revision: input.catalog.revision, systemEpoch: input.catalog.systemEpoch, entries: input.catalog.entries, coordinates: input.catalog.coordinates };
      const actual = { version: current.version, revision: current.revision, systemEpoch: current.systemEpoch, entries: current.entries, coordinates: current.coordinates };
      if (canonicalJson(reviewed) !== canonicalJson(actual)) throw new Error("The template registry changed after review");
      await verifyPublication(ctx, input.publication, input.credential);
      const idCollision = current.entries.find((candidate) => candidate.id === input.entry.id && candidate.url !== input.publication.templateUrl);
      if (idCollision) throw new Error(`Registry id ${input.entry.id} already belongs to ${idCollision.url}`);
      const urlCollision = current.entries.find((candidate) => candidate.url === input.publication.templateUrl && candidate.id !== input.entry.id);
      if (urlCollision) throw new Error(`Published template URL already belongs to registry id ${urlCollision.id}`);
      const entry = { ...input.entry, tags: [...new Set(input.entry.tags)].sort(), url: input.publication.templateUrl, promoted: { ref: input.publication.ref, commit: input.publication.commit, snapshot: input.publication.snapshot } };
      const entries = current.entries.filter((candidate) => candidate.id !== entry.id).concat(entry).sort((a, b) => a.id.localeCompare(b.id, "en"));
      if (canonicalJson(entries) === canonicalJson(current.entries) && input.revision === current.revision) {
        return { operationId: input.commandId, outcome: "nothing-to-suggest" as const, registryUrl: current.coordinates.url, baseCommit: current.coordinates.commit, branch: null, headCommit: null, revision: input.revision, entry };
      }
      if (input.revision === current.revision) throw new Error("A changed registry entry requires a new promotion revision");
      const registryDocument = YAML.stringify(parseTemplateRegistry({ version: 1, revision: input.revision, systemEpoch: current.systemEpoch, entries }), { lineWidth: 0 });
      const workspace = WorkspaceConfigSchema.parse((await ctx.workspace.getInfo()).config);
      const registryCredential = workspace.templateRegistry?.credential;
      const result = await ctx.extensions.invoke<{ outcome: "pushed" | "already-at-remote" | "nothing-to-suggest"; registryUrl: string; baseCommit: string; branch: string | null; headCommit: string | null }>("@workspace-extensions/git-bridge", "suggestRegistryEntry", [{
        operationId: input.commandId, registryUrl: current.coordinates.url, baseCommit: current.coordinates.commit,
        baseSnapshot: current.coordinates.snapshot, registryDocument, entryId: entry.id,
        ...(registryCredential ? { credential: registryCredential } : {}),
      }]);
      return { operationId: input.commandId, ...result, revision: input.revision, entry };
    },
  };
}
export type Api = Awaited<ReturnType<typeof activate>>;
