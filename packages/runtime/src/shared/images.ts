import { base64ToBytes, type RpcCaller } from "@vibestudio/rpc";
import { createDurableObjectServiceClient } from "./workerd.js";

export const IMAGE_REFERENCE_LIMIT = 16;
export const IMAGE_SERVICE_PROTOCOL = "vibestudio.images.v1";
/** Persist this small immutable reference in app state; never persist display URLs. */
export interface ImageAsset {
  id: string;
  digest: string;
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  width: number;
  height: number;
  byteLength: number;
  provenance: {
    provider: string;
    imageModel: string;
    responseModel?: string;
    responseId?: string;
    imageId?: string;
    revisedPrompt?: string;
    createdAt: number;
    artDirection?: ArtDirectionRef;
  };
}
export interface ArtDirectionRef {
  id: string;
  version: number;
}
export interface ArtDirection extends ArtDirectionRef {
  brief: string;
  references: ImageAsset[];
}
export interface ImageGenerationRequest {
  /** Stable per intended generation; replay returns the same job. Retry uses retry(jobId). */
  requestId: string;
  prompt: string;
  references?: ImageAsset[];
  artDirection?: ArtDirectionRef;
  size?: "auto" | "1024x1024" | "1536x1024" | "1024x1536";
  quality?: "auto" | "low" | "medium" | "high";
  background?: "auto" | "opaque" | "transparent";
  outputFormat?: "png" | "jpeg" | "webp";
}
export interface ImageGenerationJob {
  id: string;
  requestId: string;
  status: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempt: number;
  createdAt: number;
  updatedAt: number;
  asset?: ImageAsset;
  error?: string;
}
export interface ImagesService {
  generate(request: ImageGenerationRequest): Promise<ImageGenerationJob>;
  getJob(id: string): Promise<ImageGenerationJob>;
  cancel(id: string): Promise<ImageGenerationJob>;
  retry(id: string): Promise<ImageGenerationJob>;
  forgetJob(id: string): Promise<void>;
  deleteArtDirection(ref: ArtDirectionRef): Promise<void>;
  getAsset(id: string): Promise<ImageAsset>;
  readAsset(id: string): Promise<{ asset: ImageAsset; base64: string }>;
  importAsset(input: { base64: string; owner?: string }): Promise<ImageAsset>;
  retain(input: { assetId: string; owner: string }): Promise<void>;
  release(input: { assetId: string; owner: string }): Promise<void>;
  putArtDirection(input: {
    id: string;
    brief: string;
    references?: ImageAsset[];
  }): Promise<ArtDirection>;
  getArtDirection(ref: ArtDirectionRef): Promise<ArtDirection>;
}
export interface ImagesClient extends ImagesService {
  /** Wait only observes. Aborting the wait does not cancel the durable job. */
  wait(
    id: string,
    options?: { signal?: AbortSignal; intervalMs?: number }
  ): Promise<ImageGenerationJob>;
  /** Authenticated, workspace-scoped read. Bytes stay out of application state. */
  getBytes(asset: Pick<ImageAsset, "id"> & Partial<ImageAsset>): Promise<Uint8Array>;
}
export function createImagesClient(rpc: RpcCaller): ImagesClient {
  const service = createDurableObjectServiceClient(rpc, IMAGE_SERVICE_PROTOCOL);
  const client: ImagesClient = {
    generate: (request) => service.call("generate", request),
    getJob: (id) => service.call("getJob", id),
    cancel: (id) => service.call("cancel", id),
    retry: (id) => service.call("retry", id),
    forgetJob: (id) => service.call("forgetJob", id),
    deleteArtDirection: (ref) => service.call("deleteArtDirection", ref),
    getAsset: (id) => service.call("getAsset", id),
    readAsset: (id) => service.call("readAsset", id),
    importAsset: (input) => service.call("importAsset", input),
    retain: (input) => service.call("retain", input),
    release: (input) => service.call("release", input),
    putArtDirection: (input) => service.call("putArtDirection", input),
    getArtDirection: (ref) => service.call("getArtDirection", ref),
    async getBytes(asset) {
      const result = await client.readAsset(asset.id);
      for (const key of ["id", "digest", "mimeType", "width", "height", "byteLength"] as const) {
        if (asset[key] !== undefined && asset[key] !== result.asset[key]) {
          throw new Error(`Image asset ${asset.id} has inconsistent ${key} metadata`);
        }
      }
      return base64ToBytes(result.base64);
    },
    async wait(id, options = {}) {
      const interval = options.intervalMs ?? 500;
      if (!Number.isFinite(interval) || interval < 10)
        throw new Error("intervalMs must be at least 10");
      for (;;) {
        options.signal?.throwIfAborted();
        const job = await client.getJob(id);
        options.signal?.throwIfAborted();
        if (!["queued", "running"].includes(job.status)) return job;
        await new Promise<void>((resolve, reject) => {
          const signal = options.signal;
          const abort = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
            reject(signal?.reason);
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener("abort", abort);
            resolve();
          }, interval);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) abort();
        });
      }
    },
  };
  return client;
}
