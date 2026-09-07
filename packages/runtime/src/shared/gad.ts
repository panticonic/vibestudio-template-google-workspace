import type { RpcCaller } from "@vibestudio/rpc";
import type {
  UserNotification,
  UserNotificationAcknowledgementResult,
  UserNotificationListResult,
} from "@vibestudio/shared/userNotifications";
import { createGadServiceClient } from "@vibestudio/shared/workspaceServiceRpc";
import { type ServiceCallFn, type TypedServiceClient } from "@vibestudio/shared/typedServiceClient";
import { createLazyTypedServiceClient } from "@vibestudio/shared/lazyTypedServiceClient";
import {
  type gadMethods,
  type gadWireMethods,
  type EnvelopeLineage,
  type PrivateLineageForPublishedEnvelope,
  type PublishedArtifact,
} from "@vibestudio/service-schemas/workspaceSource";
import {
  BLOBSTORE_METHOD_NAMES,
  GAD_METHOD_NAMES,
} from "@vibestudio/service-schemas/clients/generated/runtimeClientMethods";
import type { ChannelEnvelopePage } from "@vibestudio/shared/channelEnvelopePaging";
import { hydrateStoredValueRefs } from "@workspace/agentic-protocol/stored-values";
import type { ChannelEnvelope, TrajectoryEvent } from "@workspace/agentic-protocol";

export { GAD_WORKSPACE_SERVICE_PROTOCOL } from "@vibestudio/shared/workspaceServiceRpc";
export type * from "@vibestudio/service-schemas/workspaceSource";

/** Typed entirely from the shared GAD runtime method schemas. */
export type GadClient = TypedServiceClient<typeof gadMethods>;

export function createGadClient(rpc: RpcCaller): GadClient {
  const service = createGadServiceClient(rpc);
  const wireTransport: ServiceCallFn = (_service, method, args) => service.call(method, ...args);
  const call = async <T>(method: keyof typeof gadWireMethods & string, ...args: unknown[]) => {
    const { callTypedServiceMethod } = await import("@vibestudio/shared/typedServiceClient");
    return callTypedServiceMethod(
      "gad-wire",
      (await import("@vibestudio/service-schemas/workspaceSource")).gadWireMethods,
      wireTransport,
      method,
      args
    ) as Promise<T>;
  };
  const blobstore = createLazyTypedServiceClient(
    "blobstore",
    BLOBSTORE_METHOD_NAMES,
    async () => (await import("@vibestudio/service-schemas/blobstore")).blobstoreMethods,
    (svc, method, args) => rpc.call("main", `${svc}.${method}`, args)
  );
  const hydrate = async <T>(value: T): Promise<T> =>
    hydrateStoredValueRefs(value, {
      getText: (digest) => blobstore.getText(digest),
    }) as Promise<T>;
  const hydrateLineage = async (item: EnvelopeLineage): Promise<EnvelopeLineage> => ({
    ...item,
    envelope: await hydrate(item.envelope),
    trajectoryEvent: await hydrate(item.trajectoryEvent),
  });

  const adapter: GadClient = {
    status: () => call("getStatus"),
    ensureBlob: (hash, size, mimeType) => call("ensureBlob", hash, size, mimeType),
    listUserNotificationsForMe: async (input) =>
      (
        await call<UserNotificationListResult>(
          "listUserNotificationsForMe",
          ...(input ? [input] : [])
        )
      ).notifications,
    acknowledgeUserNotification: async (id) =>
      (
        await call<UserNotificationAcknowledgementResult>("acknowledgeUserNotification", {
          id,
        })
      ).acknowledged,
    putUserNotification: (input) => call<UserNotification>("putUserNotification", input),
    deleteUserNotification: async (userId, id) =>
      (
        await call<{ deleted: boolean }>("deleteUserNotification", {
          userId,
          id,
        })
      ).deleted,
    getTrajectoryBranchHead: (input) => call("getTrajectoryBranchHead", input),
    listTrajectoryBranches: (input) => call("listTrajectoryBranches", input),
    listTrajectoryInvocations: (input) => call("listTrajectoryInvocations", input),
    listTrajectoryApprovals: (input) => call("listTrajectoryApprovals", input),
    listChannelEnvelopes: (input) => call("listChannelEnvelopes", input),
    listTrajectoryEvents: async (input) =>
      Promise.all(
        (await call<TrajectoryEvent[]>("listTrajectoryEvents", input)).map((event) =>
          hydrate(event)
        )
      ),
    appendChannelEnvelope: (input) =>
      call<ChannelEnvelope>("appendChannelEnvelope", input).then(hydrate),
    listMessageTypes: (input) => call("listMessageTypes", input),
    getMessageType: (input) => call("getMessageType", input),
    getChannelEnvelope: (input) =>
      call<ChannelEnvelope | null>("getChannelEnvelope", input).then((value) =>
        value ? hydrate(value) : null
      ),
    getTrajectoryForEnvelope: (input) =>
      call<EnvelopeLineage | null>("getTrajectoryForEnvelope", input).then((value) =>
        value ? hydrateLineage(value) : null
      ),
    resolveTrajectoryForkPoint: (input) => call("resolveTrajectoryForkPoint", input),
    listPublishedEnvelopesForTrajectory: async (input) =>
      Promise.all(
        (await call<EnvelopeLineage[]>("listPublishedEnvelopesForTrajectory", input)).map(
          hydrateLineage
        )
      ),
    getEnvelopesForTrajectory: async (input) =>
      Promise.all(
        (await call<EnvelopeLineage[]>("getEnvelopesForTrajectory", input)).map(hydrateLineage)
      ),
    getPublishedArtifactsForTurn: async (input) =>
      Promise.all(
        (await call<PublishedArtifact[]>("getPublishedArtifactsForTurn", input)).map(
          async (item) => ({
            ...item,
            lineage: await hydrateLineage(item.lineage),
          })
        )
      ),
    getPrivateLineageForPublishedEnvelope: async (input) => {
      const value = await call<PrivateLineageForPublishedEnvelope | null>(
        "getPrivateLineageForPublishedEnvelope",
        input
      );
      return value
        ? {
            ...value,
            lineage: await hydrateLineage(value.lineage),
            branchEvents: await Promise.all(value.branchEvents.map((event) => hydrate(event))),
          }
        : null;
    },
    getDownstreamConsumers: async (input) =>
      Promise.all(
        (await call<TrajectoryEvent[]>("getDownstreamConsumers", input)).map((event) =>
          hydrate(event)
        )
      ),
    readChannelEnvelopes: async (input) => {
      const page = await call<ChannelEnvelopePage<ChannelEnvelope>>("readChannelEnvelopes", input);
      return {
        ...page,
        items: await Promise.all(page.items.map((envelope) => hydrate(envelope))),
      };
    },
    inspectChannelEnvelopes: (input) => call("inspectChannelEnvelopes", input),
    listStoredValueRefs: (input) => call("listStoredValueRefs", input ?? {}),
    inspectStorageDiagnostics: (input) => call("inspectStorageDiagnostics", input ?? {}),
    inspectPublicationIntegrity: (input) => call("inspectPublicationIntegrity", input ?? {}),
    inspectTurnState: (input) => call("inspectTurnState", input ?? {}),
    inspectInvocationState: (input) => call("inspectInvocationState", input ?? {}),
    diagnoseInvocation: (input) => call("diagnoseInvocation", input),
    inspectChannelRoster: (input) => call("inspectChannelRoster", input),
    inspectAgentHealth: (input) => call("inspectAgentHealth", input),
    listAgentDirectory: (input) => call("listAgentDirectory", input ?? {}),
    searchAgentDirectory: (input) => call("searchAgentDirectory", input),
    describeChannels: (input) => call("describeChannels", input ?? {}),
    validateGadHashes: (input) => call("validateGadHashes", input),
    clearDirtyAfterValidation: (input) => call("clearDirtyAfterValidation", input),
    checkGadIntegrity: (input) => call("checkGadIntegrity", input),
    rebuildTrajectoryProjections: (input) => call("rebuildTrajectoryProjections", input),
  };

  return createLazyTypedServiceClient(
    "gad",
    GAD_METHOD_NAMES,
    async () => (await import("@vibestudio/service-schemas/workspaceSource")).gadMethods,
    (_service, method, args) => {
      const member = (adapter as unknown as Record<string, unknown>)[method];
      if (typeof member !== "function") {
        throw new Error(`GAD public adapter has no method ${JSON.stringify(method)}`);
      }
      return (member as (...values: unknown[]) => Promise<unknown>)(...args);
    }
  );
}
