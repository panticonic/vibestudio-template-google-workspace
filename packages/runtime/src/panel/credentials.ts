import type { RpcCaller } from "@vibestudio/rpc";
import {
  createCredentialClient,
  type ClientConfigStatus,
  type ConfigureClientRequest,
  type ConnectCredentialRequest,
  type CredentialClient,
  type CredentialStoreSummary,
  type DeleteClientConfigRequest,
  type GetClientConfigStatusRequest,
  type GitHttpClient,
  type ManagedCredentialSummary,
  type RequestCredentialInputRequest,
  type ResolveUrlBoundCredentialRequest,
  type StoredCredentialSummary,
  type StoreUrlBoundCredentialRequest,
} from "../shared/credentials.js";

let client: CredentialClient | null = null;

function requireClient(): CredentialClient {
  if (!client) {
    throw new Error("Panel credentials have not been initialized");
  }
  return client;
}

export function initPanelCredentials(rpc: RpcCaller): void {
  if (!client) {
    client = createCredentialClient(rpc);
  }
}

export async function store(
  input: StoreUrlBoundCredentialRequest
): Promise<StoredCredentialSummary> {
  return requireClient().store(input);
}

export async function connect(input: ConnectCredentialRequest): Promise<StoredCredentialSummary> {
  return requireClient().connect(input);
}

export async function configureClient(input: ConfigureClientRequest): Promise<ClientConfigStatus> {
  return requireClient().configureClient(input);
}

export async function requestCredentialInput(
  input: RequestCredentialInputRequest
): Promise<StoredCredentialSummary> {
  return requireClient().requestCredentialInput(input);
}

export async function getClientConfigStatus(
  input: GetClientConfigStatusRequest
): Promise<ClientConfigStatus> {
  return requireClient().getClientConfigStatus(input);
}

export async function deleteClientConfig(input: DeleteClientConfigRequest | string): Promise<void> {
  return requireClient().deleteClientConfig(input);
}

export async function listStoredCredentials(): Promise<StoredCredentialSummary[]> {
  return requireClient().listStoredCredentials();
}

export async function summarizeStoredCredentials(): Promise<CredentialStoreSummary> {
  return requireClient().summarizeStoredCredentials();
}

export async function inspectStoredCredentials(): Promise<ManagedCredentialSummary[]> {
  return requireClient().inspectStoredCredentials();
}

export async function revokeCredential(credentialId: string): Promise<void> {
  await requireClient().revokeCredential(credentialId);
}

export async function resolveCredential(
  input: ResolveUrlBoundCredentialRequest
): Promise<StoredCredentialSummary | null> {
  return requireClient().resolveCredential(input);
}

export async function fetch(
  url: string | URL,
  init?: RequestInit,
  opts?: { credentialId?: string }
): Promise<Response> {
  return requireClient().fetch(url, init, opts);
}

export function hookForUrl(
  url: string | URL,
  opts?: { credentialId?: string }
): (init?: RequestInit) => Promise<Response> {
  return requireClient().hookForUrl(url, opts);
}

export function gitHttp(opts?: { credentialId?: string | null }): GitHttpClient {
  return requireClient().gitHttp(opts);
}

export type {
  ClientConfigStatus,
  ConfigureClientRequest,
  ConnectCredentialRequest,
  CredentialAccessGrantSummary,
  CredentialAccessSubjectSummary,
  CredentialStoreSummary,
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
