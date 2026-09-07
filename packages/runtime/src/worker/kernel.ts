/**
 * Minimal Durable Object authoring surface.
 *
 * This entry deliberately excludes the connected worker runtime and its
 * panel, browser, GAD, credential, and extension clients. Import the full
 * `@workspace/runtime/worker` entry only when module-level worker code uses
 * those connected facilities.
 */
export { rpc, schemaRpc } from "@vibestudio/rpc";
export { DurableObjectBase } from "./durable-base.js";
export type {
  DurableObjectContext,
  SqlStorage,
  SqlResult,
  TypedSqlStorage,
  DORef,
  LifecyclePrepareInput,
  LifecyclePrepareResult,
  LifecycleResumeInput,
} from "./durable-base.js";
export { assertExactSqlTableSchema } from "./sql-table-schema.js";
export {
  createDurableObjectServiceClient,
  doTargetId,
} from "../shared/workerd.js";
export type {
  DurableObjectServiceClient,
  ResolvedWorkspaceService,
  WorkspaceServiceInfo,
  WorkerSourceInfo,
} from "../shared/workerd.js";
