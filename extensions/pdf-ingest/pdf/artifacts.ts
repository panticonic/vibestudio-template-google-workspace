import type { ExtensionContext } from "@vibestudio/extension";
import { sha256Hex } from "./binary.js";
import type { PdfArtifact } from "./types.js";

const ARTIFACT_PREFIX = "pdf-artifact";
const ARTIFACT_DIR = "artifacts";

export interface ArtifactStore {
  put(data: Uint8Array, mimeType: string): Promise<{ artifactId: string; digest: string }>;
  get(artifactId: string): Promise<PdfArtifact>;
}

interface StorageLike {
  mkdir(path: string, opts?: { recursive?: boolean }): Promise<unknown>;
  readFile(path: string, encoding?: BufferEncoding): Promise<string | Buffer>;
  writeFile(path: string, data: string | Uint8Array): Promise<void>;
}

export function createArtifactStore(ctx: Pick<ExtensionContext, "storage">): ArtifactStore {
  return createArtifactStoreFromStorage(ctx.storage);
}

export function createArtifactStoreFromStorage(storage: StorageLike): ArtifactStore {
  return {
    async put(data, mimeType) {
      const digest = sha256Hex(data);
      const ext = extensionForMimeType(mimeType);
      const artifactId = `${ARTIFACT_PREFIX}:${ext}:${digest}`;
      await storage.mkdir(ARTIFACT_DIR, { recursive: true });
      await storage.writeFile(`${ARTIFACT_DIR}/${digest}.${ext}`, data);
      return { artifactId, digest };
    },

    async get(artifactId) {
      const parsed = parseArtifactId(artifactId);
      const file = await storage.readFile(`${ARTIFACT_DIR}/${parsed.digest}.${parsed.ext}`);
      return {
        artifactId,
        digest: parsed.digest,
        mimeType: mimeTypeForExtension(parsed.ext),
        data: file instanceof Buffer ? new Uint8Array(file) : new Uint8Array(Buffer.from(file)),
      };
    },
  };
}

function parseArtifactId(artifactId: string): { ext: string; digest: string } {
  const parts = artifactId.split(":");
  if (parts.length !== 3 || parts[0] !== ARTIFACT_PREFIX) {
    throw new Error(`pdf-ingest: invalid artifact id ${artifactId}`);
  }
  const ext = parts[1] ?? "";
  const digest = parts[2] ?? "";
  if (!/^[a-z0-9]+$/.test(ext) || !/^[a-f0-9]{64}$/.test(digest)) {
    throw new Error(`pdf-ingest: invalid artifact id ${artifactId}`);
  }
  return { ext, digest };
}

function extensionForMimeType(mimeType: string): string {
  if (mimeType === "image/png") return "png";
  if (mimeType === "application/json") return "json";
  if (mimeType === "text/plain") return "txt";
  throw new Error(`pdf-ingest: unsupported artifact MIME type ${mimeType}`);
}

function mimeTypeForExtension(ext: string): string {
  if (ext === "png") return "image/png";
  if (ext === "json") return "application/json";
  if (ext === "txt") return "text/plain";
  throw new Error(`pdf-ingest: unsupported artifact extension ${ext}`);
}
