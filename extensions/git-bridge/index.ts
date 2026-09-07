/**
 * git-bridge extension — the platform's git interchange venue (eviction stage
 * P5c part 2). Hosts the {@link GitBridge} core in a trusted Node extension
 * process and adapts it onto the platform primitives:
 *
 *  - the canonical public `vcs.*` service over the same main transport used by
 *    panels, tools, and agents
 *  - raw Node disk access for operational checkouts under workspace host state
 *
 * The host reaches it exclusively through the manifest-declared
 * `providers.gitInterop` slot. Userland calls the selected provider directly
 * through the runtime `git` client and never names this extension.
 */

import type {
  GitCommitMappingOptions,
  GitInteropProvider,
  GitPublishRepoInput,
  GitPullUpstreamOptions,
  GitPushUpstreamOptions,
  GitTemplatePublishInput,
  GitUpstreamStatusOptions,
} from "@vibestudio/service-schemas/gitInterop";
import { blobstoreMethods } from "@vibestudio/service-schemas/blobstore";
import { vcsMethods } from "@vibestudio/service-schemas/vcs";
import { runtimeMethods } from "@vibestudio/service-schemas/runtime";
import { createTypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { gitCheckoutsPath } from "@vibestudio/workspace/gitCheckouts";
import { GitBridge, type BridgeHost } from "./bridge.js";
import { UpstreamEngine } from "./upstream.js";
import { TemplatePushEngine } from "./templatePush.js";
import { TemplatePublishEngine } from "./templatePublish.js";
import type { TemplatePushInput } from "./templatePush.js";
import {
  RegistryContributionEngine,
  type RegistryContributionInput,
} from "./registryContribution.js";
import type { ExtensionContextLike } from "./context.js";

function createBridgeHost(ctx: ExtensionContextLike): BridgeHost {
  const main = <T>(method: string, ...args: unknown[]): Promise<T> =>
    ctx.rpc.call<T>("main", method, ...args);
  const vcs = createTypedServiceClient("vcs", vcsMethods, (_service, method, args) =>
    main(`vcs.${method}`, ...args)
  );
  const blobstore = createTypedServiceClient(
    "blobstore",
    blobstoreMethods,
    (_service, method, args) => main(`blobstore.${method}`, ...args)
  );
  const runtime = createTypedServiceClient("runtime", runtimeMethods, (_service, method, args) =>
    main(`runtime.${method}`, ...args)
  );

  return {
    checkoutRoot: async () => gitCheckoutsPath(ctx.storage.root),
    ensureContext: async (contextId) => {
      await runtime.createContext({ contextId });
    },
    blobstore,
    vcs,
  };
}

type GitBridgeApi = {
  providerContracts: { gitInterop: GitInteropProvider };
  retryUpstreamPush(repoPath: string): Promise<unknown>;
  pauseAutoPush(repoPath: string): Promise<unknown>;
  openGitTab(repoPath?: string): ReturnType<UpstreamEngine["openGitTab"]>;
  /** Userland template composer entry; deliberately outside the host provider namespace. */
  suggestTemplateContribution(input: TemplatePushInput): ReturnType<TemplatePushEngine["push"]>;
  suggestRegistryEntry(
    input: RegistryContributionInput
  ): ReturnType<RegistryContributionEngine["suggest"]>;
  publishTemplate(input: GitTemplatePublishInput): ReturnType<TemplatePublishEngine["publish"]>;
};

/** Internal provider surface exposed to the extension host. */
export type Api = Awaited<ReturnType<typeof activate>>;
// Intentionally NOT registered in the WorkspaceExtensions type registry:
// git-bridge is host/agent infrastructure, not a panel-facing client library.

export async function activate(ctx: ExtensionContextLike) {
  ctx.log.info("git-bridge activating");
  const bridge = new GitBridge(createBridgeHost(ctx));
  const upstream = new UpstreamEngine(ctx, bridge);
  const templatePush = new TemplatePushEngine(ctx, bridge);
  const templatePublish = new TemplatePublishEngine(ctx, bridge);
  const registryContribution = new RegistryContributionEngine(ctx);
  await upstream.activate();
  const unsubscribe = ctx.rpc.on?.("workspace:protected-refs-changed", (event) => {
    const payload = event.payload as { repoPaths?: unknown };
    if (
      !Array.isArray(payload.repoPaths) ||
      !payload.repoPaths.every((item) => typeof item === "string")
    ) {
      ctx.log.warn?.("ignored malformed protected-ref event");
      return;
    }
    upstream.reconcileUpstreams(payload.repoPaths.map((repoPath) => ({ repoPath })));
  });
  if (unsubscribe) ctx.subscriptions?.push({ dispose: unsubscribe });
  const gitInterop = {
    setSharedRemote(repoPath: string, remote: Parameters<UpstreamEngine["setRemote"]>[1]) {
      return upstream.setRemote(repoPath, remote);
    },
    removeSharedRemote(repoPath: string, remoteName: string) {
      return upstream.removeRemote(repoPath, remoteName);
    },
    setUpstream(repoPath: string, config: Parameters<UpstreamEngine["setUpstream"]>[1]) {
      return upstream.setUpstream(repoPath, config);
    },
    removeUpstream(repoPath: string) {
      return upstream.removeUpstream(repoPath);
    },
    detachUpstream(repoPath: string, options?: Parameters<UpstreamEngine["detachUpstream"]>[1]) {
      return upstream.detachUpstream(repoPath, options);
    },
    setAutoPush(repoPath: string, enabled: boolean) {
      return upstream.setAutoPush(repoPath, enabled);
    },
    upstreamStatus(repoPaths: string[], options: GitUpstreamStatusOptions = {}) {
      return upstream.upstreamStatus(repoPaths, options);
    },
    pushUpstream(repoPath: string, options?: GitPushUpstreamOptions) {
      return upstream.pushUpstream(repoPath, options);
    },
    pullUpstream(repoPath: string, options?: GitPullUpstreamOptions) {
      return upstream.pullUpstream(repoPath, options);
    },
    publishRepo(input: GitPublishRepoInput) {
      return upstream.publishRepo(input);
    },
    commitMapping(repoPath: string, options: GitCommitMappingOptions = {}) {
      return upstream.commitMapping(repoPath, options);
    },
    importProject(input: Parameters<UpstreamEngine["importProject"]>[0]) {
      return upstream.importProject(input);
    },
    cloneRepo(input: { repoPath: string; credentialIdOverride?: string | null }) {
      return upstream.cloneRepo(input);
    },
    remoteDefaultBranch(input: { url: string; credentialIdOverride?: string | null }) {
      return upstream.remoteDefaultBranch(input);
    },
    async reconcileUpstreams(
      entries: Array<{ repoPath: string; credentialIdOverride?: string | null }>
    ) {
      upstream.reconcileUpstreams(entries);
      return { queued: entries.length };
    },
  } satisfies GitInteropProvider;
  const api = {
    providerContracts: { gitInterop },
    retryUpstreamPush(repoPath: string) {
      return upstream.pushUpstream(repoPath);
    },
    pauseAutoPush(repoPath: string) {
      return upstream.setAutoPush(repoPath, false);
    },
    openGitTab(repoPath?: string) {
      return upstream.openGitTab(repoPath);
    },
    suggestTemplateContribution(input: TemplatePushInput) {
      return templatePush.push(input);
    },
    suggestRegistryEntry(input: RegistryContributionInput) {
      return registryContribution.suggest(input);
    },
    publishTemplate(input: GitTemplatePublishInput) {
      return templatePublish.publish(input);
    },
  } satisfies GitBridgeApi;
  return api;
}
