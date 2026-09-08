import { sha256Hex } from "@vibestudio/content-addressing";
import {
  SemanticWorkspace as Engine,
  type SemanticDispatchRequest,
  type SemanticDispatchResult,
} from "./semanticWorkspace.js";
export type { SemanticDispatchRequest, SemanticDispatchResult } from "./semanticWorkspace.js";

/** Simulate the host CAS boundary while leaving explicit content reads visible to tests. */
export class SemanticWorkspace extends Engine {
  readonly preparedContent = new Map<string, Uint8Array>();
  private prepare(result: SemanticDispatchResult): SemanticDispatchResult {
    while (result.kind === "host-content") {
      const blobs = result.request["blobs"] as Array<{
        contentHash: string;
        base64: string;
      }>;
      for (const blob of blobs) {
        const bytes = Uint8Array.from(atob(blob.base64), (char) => char.charCodeAt(0));
        if (sha256Hex(bytes) !== blob.contentHash)
          throw new Error("Host received invalid content identity");
        this.preparedContent.set(blob.contentHash, bytes);
      }
      result = super.acknowledgeContent({
        request: result.request,
        contentHashes: blobs.map((blob) => blob.contentHash).sort(),
      });
    }
    return result;
  }
  override async dispatch(
    method: string,
    request: SemanticDispatchRequest
  ): Promise<SemanticDispatchResult> {
    return this.prepare(await super.dispatch(method, request));
  }
  override acknowledgeHostRead(
    input: Parameters<Engine["acknowledgeHostRead"]>[0]
  ): SemanticDispatchResult {
    return this.prepare(super.acknowledgeHostRead(input));
  }
}
