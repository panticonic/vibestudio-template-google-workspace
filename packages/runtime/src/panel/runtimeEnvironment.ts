import type { EndpointInfo } from "../core/index.js";
import type { PanelBootObservation } from "@vibestudio/shared/panel/observation";

/** Presentation inputs belong to one runtime instance, independent of its RPC carrier. */
export interface PanelRuntimeEnvironment {
  events?: {
    subscribe(handler: (event: string, payload: unknown) => void): () => void;
  };
  modeChanged?: (mode: import("./agentApi.js").AgentDataMode) => void;
  document?: Document;
  location?: Pick<Location, "href" | "pathname" | "search" | "hash">;
  boot?: {
    initial?: PanelBootObservation;
    subscribe(handler: (observation: PanelBootObservation) => void): () => void;
    report?(observation: PanelBootObservation): void;
  };
  stateArgs?: {
    initial: Record<string, unknown>;
    changed(snapshot: Record<string, unknown>): void;
  };
  getInfo?: () => Promise<EndpointInfo>;
  focusPanel?: (panelId: string) => Promise<unknown>;
}
