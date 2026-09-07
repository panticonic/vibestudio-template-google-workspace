/**
 * Worker-side credential client types.
 *
 * Worker-side code (DOs and workerd workers) should access credentials
 * through the runtime's `credentials` namespace, which is bound to the
 * correct caller-identity RPC bridge for the current context:
 *
 *   // In a DurableObject:
 *   this.credentials.fetch(url, init);
 *
 *   // In a workerd worker:
 *   import { credentials } from "@workspace/runtime/worker";
 *   credentials.fetch(url, init);
 *
 * This module previously exported a module-singleton credential client
 * built on a global RPC caller (`workerHostRpcCaller`). That created
 * two parallel RPC paths in DOs (the DO's `this.rpc` and the global
 * one) with different auth tokens. The module-singleton has been
 * removed; only types are re-exported here so existing
 * `import type { ... } from "@workspace/runtime/worker/credentials"`
 * sites keep working.
 */

export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  CredentialClient,
  DeleteClientConfigRequest,
  GetClientConfigStatusRequest,
  GitHttpClient,
  GrantUrlBoundCredentialRequest,
  ManagedCredentialSummary,
  RequestCredentialInputRequest,
  ResolveUrlBoundCredentialRequest,
  StoredCredentialSummary,
  StoreUrlBoundCredentialRequest,
} from "../shared/credentials.js";
