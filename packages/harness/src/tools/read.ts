/**
 * Read tool — workerd port of pi-coding-agent's `dist/core/tools/read.js`.
 *
 * Differences from upstream:
 * - File I/O goes through `RuntimeFs` (no `fs/promises`).
 * - Image handling is delegated to the image service extension; detection
 *   uses magic-byte sniffing rather than the filename-extension table that
 *   pi-coding-agent ships.
 */
import { Type, type Static } from "@sinclair/typebox";
import type { AgentTool } from "@workspace/pi-core";
import type { TextContent, ImageContent } from "@workspace/pi-ai";
import type { RuntimeFs } from "./runtime-fs.js";
import type { RpcCaller } from "@vibestudio/rpc";
import { createExtensionProxy } from "@vibestudio/extension";
import { resolveToCwd } from "./path-utils.js";
import { sha256Hex } from "@vibestudio/content-addressing";
import { splitRepoPath } from "@vibestudio/shared/runtime/entitySpec";
import type { VcsReadMemoryResult } from "@vibestudio/service-schemas/vcs";
import { toVcsPath, toolContextId, type ToolVcs, type ToolWorkspaceContext } from "./tool-vcs.js";
import { renderReadMemoryBlock } from "./read-memory.js";
import type { AgentReferenceStore } from "./agent-pagination.js";
import { putProvenanceReference } from "./provenance-reference.js";
import type { AgentFileVisibility } from "./agent-file-visibility.js";
import {
  AGENT_TOOL_ARTIFACT_PROTOCOL,
  agentToolArtifactRefSchema,
  artifactDigestFromUri,
  type AgentToolArtifactRef,
} from "@workspace/agentic-protocol";
import {
  base64ToBytes,
  bytesToBase64,
  decodeUtf8,
  encodeUtf8,
  utf8ByteLength,
} from "./portable-bytes.js";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  type TruncationResult,
} from "./truncate.js";
import {
  canonicalObservationPath,
  type WorkspaceFileObservationStore,
} from "./file-observations.js";
const readSchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({ description: "Path to the file to read (relative or absolute)" })
    ),
    target: Type.Optional(
      Type.String({
        description:
          "File resource reference to read, normally a file:<path> value returned by another tool.",
      })
    ),
    kind: Type.Optional(Type.Literal("file")),
    resource: Type.Optional(
      Type.Object(
        {
          protocol: Type.Literal(AGENT_TOOL_ARTIFACT_PROTOCOL),
          uri: Type.String({ pattern: "^artifact:[0-9a-f]{64}$" }),
          digest: Type.String({ pattern: "^[0-9a-f]{64}$" }),
          byteLength: Type.Integer({ minimum: 0 }),
          mediaType: Type.Literal("application/json"),
          encoding: Type.Literal("json"),
          description: Type.String(),
        },
        { additionalProperties: false }
      )
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 1,
        description: "Line number to start reading from (1-indexed).",
      })
    ),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 10_000,
        description: "Maximum number of lines to read (maximum: 10000).",
      })
    ),
  },
  { additionalProperties: false }
);
export type ReadToolInput = Static<typeof readSchema>;

const readBinarySchema = Type.Object(
  {
    path: Type.Optional(
      Type.String({ description: "Path to the binary file to read (relative or absolute)." })
    ),
    target: Type.Optional(
      Type.String({
        description:
          "File resource reference to read, normally a file:<path> value returned by another tool.",
      })
    ),
    kind: Type.Optional(Type.Literal("file")),
    offset: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based raw byte offset." })),
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 1024 * 1024,
        description: "Maximum raw bytes (default: 50 KiB; maximum: 1 MiB).",
      })
    ),
  },
  { additionalProperties: false }
);
export type ReadBinaryToolInput = Static<typeof readBinarySchema>;
export interface ReadToolDetails {
  truncation?: TruncationResult;
  path?: string;
  mimeType?: string;
  size?: number;
  originalSize?: number;
  originalDimensions?: {
    width: number;
    height: number;
  };
  dimensions?: {
    width: number;
    height: number;
  };
  wasResized?: boolean;
  engine?: "runtime-fs";
  resource?: AgentToolArtifactRef;
  directory?: boolean;
  extensionFallback?: string;
  missing?: boolean;
  suggestions?: string[];
  encoding?: "text" | "base64";
  byteRange?: {
    start: number;
    end: number;
    totalBytes: number;
    nextOffset?: number;
  };
  displayedRange?: {
    coordinateKind: "utf16";
    start: number;
    end: number;
    startLine: number;
    endLine: number;
  };
  provenance?:
    | VcsReadMemoryResult
    | {
        status: "unavailable";
        path: string;
        reason: string;
      };
}
interface ImageResizeResult {
  /** Base64 payload: extension RPC return values are JSON, never typed-array objects. */
  data: string;
  mimeType: string;
  width: number;
  height: number;
  originalWidth: number;
  originalHeight: number;
  wasResized: boolean;
  dimensionNote?: string;
}
interface ReadResult {
  content: (TextContent | ImageContent)[];
  details: ReadToolDetails;
}
interface FsReadTextResult {
  text: string;
  contentHash: string;
  totalLines: number;
  totalBytes: number;
  maxLines: number;
  maxBytes: number;
  startLine: number;
  endLine: number;
  start: number;
  end: number;
  truncated: boolean;
  truncatedBy?: "lines" | "bytes";
  nextOffset?: number;
  firstLineExceedsLimit: boolean;
}
interface FsReadBytesResult {
  base64: string;
  contentHash: string;
  totalBytes: number;
  maxBytes: number;
  start: number;
  end: number;
  truncated: boolean;
  nextOffset?: number;
}
interface ImageServiceApi {
  detectMimeType(bytes: BinaryEnvelope): Promise<string | null>;
  resize(
    bytes: BinaryEnvelope,
    mimeType: string,
    opts: { maxWidth: number; maxHeight: number }
  ): Promise<ImageResizeResult>;
}
interface BinaryEnvelope {
  __bin: true;
  data: string;
}
const IMAGE_SERVICE_EXTENSION = "@workspace-extensions/image-service";

export interface ReadToolDeps {
  /** RPC caller — needed for image resize. */
  rpc?: RpcCaller;
  /** Canonical GAD/VCS read-memory projection for managed source reads. */
  provenance?: {
    vcs: Pick<ToolVcs, "readMemory">;
    context: ToolWorkspaceContext;
  };
  agentReferences?: AgentReferenceStore;
  visibility?: AgentFileVisibility;
  /** Trusted state shared with mutation tools; never rendered into model output. */
  observations?: WorkspaceFileObservationStore;
}
export function createReadTool(
  cwd: string,
  fs: RuntimeFs,
  deps?: ReadToolDeps
): AgentTool<typeof readSchema, ReadToolDetails> {
  const runtimeRpc = deps?.rpc ?? null;
  const provenanceDeps = deps?.provenance ?? null;
  const imageService = deps?.rpc
    ? createExtensionProxy<ImageServiceApi>(deps.rpc, IMAGE_SERVICE_EXTENSION, () => false)
    : null;

  const resolveWorkspaceSkillAlias = async (requestedPath: string): Promise<ReadResult | null> => {
    if (!runtimeRpc) return null;
    const normalized = requestedPath.replace(/^\/+/, "");
    const match = /^(?:skills\/)?([^/]+)\/SKILL\.md$/iu.exec(normalized);
    if (!match?.[1]) return null;
    try {
      const entries = await runtimeRpc.call<
        Array<{ name: string; dirPath: string; skillPath: string }>
      >("main", "workspace.listSkills", []);
      const matches = entries.filter((entry) => entry.name === match[1]);
      if (matches.length !== 1) return null;
      const entry = matches[0]!;
      const content = await runtimeRpc.call<string>("main", "workspace.readSkill", [entry.dirPath]);
      return {
        content: [{ type: "text", text: content }],
        details: {
          path: entry.skillPath,
          engine: "runtime-fs",
          extensionFallback: `workspace-skill-alias:${requestedPath}`,
        },
      };
    } catch {
      return null;
    }
  };

  const missingResult = async (
    requestedPath: string,
    absolutePath: string
  ): Promise<ReadResult> => {
    const skillAlias = await resolveWorkspaceSkillAlias(requestedPath);
    if (skillAlias) return skillAlias;
    const slash = absolutePath.lastIndexOf("/");
    const parent = slash <= 0 ? "/" : absolutePath.slice(0, slash);
    const wanted = absolutePath.slice(slash + 1).toLowerCase();
    let suggestions: string[] = [];
    try {
      suggestions = (await fs.readdir(parent))
        .map(String)
        .sort((a, b) => {
          const aScore = similarityScore(a.toLowerCase(), wanted);
          const bScore = similarityScore(b.toLowerCase(), wanted);
          return bScore - aScore || a.localeCompare(b);
        })
        .slice(0, 12);
    } catch {
      // A missing parent has no useful siblings; the diagnostic still remains
      // a successful discovery result rather than poisoning the turn.
    }
    const hint =
      suggestions.length > 0
        ? ` Nearby entries: ${suggestions.join(", ")}.`
        : " The parent directory is also unavailable or empty.";
    return {
      content: [
        {
          type: "text",
          text: `File not found: ${requestedPath}.${hint} Use ls/find before choosing another path.`,
        },
      ],
      details: { path: requestedPath, missing: true, suggestions },
    };
  };

  const attachReadMemory = async (
    result: ReadResult,
    lineMappingContent: string,
    expectedContentHash: string,
    lineMappingStart: number,
    lineMappingStartLine: number,
    requestedPath: string,
    signal?: AbortSignal
  ): Promise<ReadResult> => {
    const displayed = result.details.displayedRange;
    if (!provenanceDeps || !displayed) return result;
    let workspacePath: string;
    try {
      workspacePath = toVcsPath(requestedPath, cwd);
    } catch {
      return result;
    }
    const split = splitRepoPath(workspacePath);
    if (!split?.repoRelPath || split.repoPath.split("/")[0] === "skills") return result;
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      const provenance = await provenanceDeps.vcs.readMemory({
        contextId: toolContextId(provenanceDeps.context),
        path: workspacePath,
        expectedContentHash,
        range: { start: displayed.start, end: displayed.end },
        episodeLimit: 4,
        historyLimit: 3,
      });
      if (signal?.aborted) throw new Error("Operation aborted");
      if (provenance.status !== "attached") {
        return {
          ...result,
          details: { ...result.details, provenance },
        };
      }
      const block = renderReadMemoryBlock({
        label: workspacePath,
        content: lineMappingContent,
        contentStart: lineMappingStart,
        contentStartLine: lineMappingStartLine,
        readingContextId: toolContextId(provenanceDeps.context),
        startLine: displayed.startLine,
        endLine: displayed.endLine,
        result: provenance,
        ...(deps?.agentReferences
          ? {
              reference: (root) => putProvenanceReference(deps.agentReferences!, root, 5),
            }
          : {}),
      });
      return {
        ...result,
        content: block
          ? [...result.content, { type: "text" as const, text: block }]
          : result.content,
        details: { ...result.details, provenance },
      };
    } catch (error) {
      if (signal?.aborted) throw new Error("Operation aborted");
      const reason = error instanceof Error ? error.message : String(error);
      return {
        ...result,
        details: {
          ...result.details,
          provenance: { status: "unavailable", path: workspacePath, reason },
        },
      };
    }
  };

  return {
    name: "read",
    label: "read",
    executionMode: "parallel",
    description: `Read a file as bounded text or a native image attachment. Supply exactly one location: path, a file target returned by discovery, or an artifact resource. Text is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB; continue with offset. Image pixels—including extensionless screenshots—are returned as model-visible image content. Use read_binary only for lossless base64 byte transport, never for visual inspection.`,
    parameters: readSchema,
    execute: async (_toolCallId, input, signal, _onUpdate) => {
      const resource =
        "resource" in input && input.resource
          ? agentToolArtifactRefSchema.parse(input.resource)
          : undefined;
      if (resource) {
        if (!runtimeRpc) throw new Error("Reading artifact resources requires runtime RPC");
        const digest = artifactDigestFromUri(resource.uri);
        if (!digest || digest !== resource.digest) {
          throw Object.assign(new Error("Artifact resource URI and digest disagree"), {
            code: "invalid_artifact_reference",
          });
        }
        const raw = await runtimeRpc.call<string | null>("main", "blobstore.getText", [digest]);
        if (raw === null) {
          throw Object.assign(new Error(`Artifact is no longer available: ${resource.uri}`), {
            code: "artifact_not_found",
          });
        }
        const formatted = formatTextResult(raw, resource.uri, input.offset, input.limit);
        return {
          ...formatted,
          details: { ...formatted.details, resource, originalSize: resource.byteLength },
        };
      }
      const path = normalizeReadLocation(input);
      if (!path) {
        return {
          content: [
            {
              type: "text",
              text: "No file reference was supplied. Call read with path, or with a file:<path> target returned by a discovery tool.",
            },
          ],
          details: { missing: true, suggestions: [] },
        };
      }
      const { offset, limit } = input;
      if (signal?.aborted) {
        throw new Error("Operation aborted");
      }
      const absolutePath = resolveToCwd(path, cwd);
      if (deps?.visibility && (await deps.visibility.isHidden(absolutePath))) {
        return {
          content: [{ type: "text", text: `Path not found: ${path}` }],
          details: { path, missing: true, suggestions: [] },
        };
      }
      // --- Image/text read ---------------------------------------------------------------
      // Text with a recognizable filename remains a single compact UTF-8 RPC
      // response. Runtime artifacts such as screenshots intentionally use
      // opaque extensionless temp paths, so those paths must be read as bytes
      // and magic-sniffed instead of being irreversibly decoded as UTF-8.
      const shouldSniffMedia = isLikelyImagePath(path) || hasNoFileExtension(path);
      if (runtimeRpc && !shouldSniffMedia) {
        try {
          const bounded = await runtimeRpc.call<FsReadTextResult>(
            "main",
            "fs.readText",
            [
              absolutePath,
              {
                offset: offset ?? 1,
                limit: limit ?? DEFAULT_MAX_LINES,
                maxBytes: DEFAULT_MAX_BYTES,
              },
            ],
            signal ? { signal } : undefined
          );
          const result = recordReadObservation(
            formatBoundedTextResult(bounded, path),
            path,
            cwd,
            bounded.contentHash,
            deps?.observations
          );
          return attachReadMemory(
            result,
            bounded.text,
            bounded.contentHash,
            bounded.start,
            bounded.startLine,
            path,
            signal
          );
        } catch (err) {
          const recovered = await recoverReadFailure(fs, path, absolutePath, signal);
          if (recovered) return recovered;
          if ((err as NodeJS.ErrnoException).code === "ENOENT") {
            return missingResult(path, absolutePath);
          }
          throw err;
        }
      }
      let raw: string | Uint8Array;
      try {
        raw = await retryTransientRuntimeFs(
          () => fs.readFile(absolutePath, shouldSniffMedia ? undefined : "utf8"),
          signal
        );
      } catch (err) {
        const recovered = await recoverReadFailure(fs, path, absolutePath, signal);
        if (recovered) return recovered;
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          return missingResult(path, absolutePath);
        }
        throw err;
      }
      if (
        raw instanceof Uint8Array &&
        imageService &&
        (isLikelyImagePath(path) || hasSupportedImageMagic(raw))
      ) {
        // Extension arguments cross a JSON RPC boundary. Preserve bytes in
        // the runtime's canonical binary envelope instead of relying on a
        // Uint8Array's in-process prototype surviving serialization.
        const binary = { __bin: true, data: bytesToBase64(raw) } as const;
        const mimeType = await imageService.detectMimeType(binary);
        if (mimeType?.startsWith("image/")) {
          const resized = await imageService.resize(binary, mimeType, {
            maxWidth: 2000,
            maxHeight: 2000,
          });
          const content: (TextContent | ImageContent)[] = [
            { type: "image", mimeType: resized.mimeType, data: resized.data },
          ];
          if (resized.dimensionNote) {
            content.unshift({ type: "text", text: resized.dimensionNote });
          }
          deps?.observations?.record(canonicalObservationPath(path, cwd), sha256Hex(raw));
          return {
            content,
            details: {
              path: absolutePath,
              mimeType: resized.mimeType,
              size: base64ToBytes(resized.data).byteLength,
              originalSize: raw.byteLength,
              originalDimensions: { width: resized.originalWidth, height: resized.originalHeight },
              dimensions: { width: resized.width, height: resized.height },
              wasResized: resized.wasResized,
            },
          };
        }
      }
      // --- Text branch -------------------------------------------------------------------
      const textContent = typeof raw === "string" ? raw : decodeUtf8(raw);
      return attachReadMemory(
        recordReadObservation(
          formatTextResult(textContent, path, offset, limit),
          path,
          cwd,
          sha256Hex(typeof raw === "string" ? encodeUtf8(raw) : raw),
          deps?.observations
        ),
        textContent,
        sha256Hex(new TextEncoder().encode(textContent)),
        0,
        1,
        path,
        signal
      );
    },
  };
}

/** Lossless bounded byte transport, deliberately separate from model-visible image reads. */
export function createReadBinaryTool(
  cwd: string,
  fs: RuntimeFs,
  deps?: Pick<ReadToolDeps, "rpc" | "visibility" | "observations">
): AgentTool<typeof readBinarySchema, ReadToolDetails> {
  const runtimeRpc = deps?.rpc ?? null;
  return {
    name: "read_binary",
    label: "read_binary",
    executionMode: "parallel",
    description:
      "Read bounded raw file bytes as lossless base64 text for binary inspection or round-tripping. Supply path or a file target; offset/limit count bytes. This tool does not make image pixels visible to the model—use read for screenshots and other images.",
    parameters: readBinarySchema,
    execute: async (_toolCallId, input, signal) => {
      const path = normalizeReadLocation(input);
      if (!path) {
        return {
          content: [
            {
              type: "text",
              text: "No file reference was supplied. Call read_binary with path, or with a file:<path> target returned by a discovery tool.",
            },
          ],
          details: { missing: true, suggestions: [] },
        };
      }
      if (signal?.aborted) throw new Error("Operation aborted");
      const absolutePath = resolveToCwd(path, cwd);
      if (deps?.visibility && (await deps.visibility.isHidden(absolutePath))) {
        return {
          content: [{ type: "text", text: `Path not found: ${path}` }],
          details: { path, missing: true, suggestions: [] },
        };
      }
      try {
        if (runtimeRpc) {
          const bounded = await runtimeRpc.call<FsReadBytesResult>(
            "main",
            "fs.readBytes",
            [
              absolutePath,
              {
                offset: input.offset ?? 0,
                limit: input.limit ?? DEFAULT_MAX_BYTES,
              },
            ],
            signal ? { signal } : undefined
          );
          return recordReadObservation(
            formatBoundedBytesResult(bounded, path),
            path,
            cwd,
            bounded.contentHash,
            deps?.observations
          );
        }
        const raw = await retryTransientRuntimeFs(() => fs.readFile(absolutePath), signal);
        const bytes = typeof raw === "string" ? encodeUtf8(raw) : raw;
        const start = Math.min(input.offset ?? 0, bytes.length);
        const selected = bytes.subarray(start, start + (input.limit ?? DEFAULT_MAX_BYTES));
        const end = start + selected.length;
        return recordReadObservation(
          formatBoundedBytesResult(
            {
              base64: bytesToBase64(selected),
              contentHash: sha256Hex(bytes),
              totalBytes: bytes.length,
              maxBytes: input.limit ?? DEFAULT_MAX_BYTES,
              start,
              end,
              truncated: end < bytes.length,
              ...(end < bytes.length ? { nextOffset: end } : {}),
            },
            path
          ),
          path,
          cwd,
          sha256Hex(bytes),
          deps?.observations
        );
      } catch (error) {
        const recovered = await recoverReadFailure(fs, path, absolutePath, signal);
        if (recovered) return recovered;
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          return {
            content: [
              {
                type: "text",
                text: `File not found: ${path}. Use ls/find before choosing another path.`,
              },
            ],
            details: { path, missing: true, suggestions: [] },
          };
        }
        throw error;
      }
    },
  };
}

function recordReadObservation(
  result: ReadResult,
  path: string,
  cwd: string,
  contentHash: string,
  observations: WorkspaceFileObservationStore | undefined
): ReadResult {
  observations?.record(canonicalObservationPath(path, cwd), contentHash);
  return result;
}

async function recoverReadFailure(
  fs: RuntimeFs,
  displayPath: string,
  absolutePath: string,
  signal?: AbortSignal
): Promise<ReadResult | null> {
  // If the target is a directory, recover with one typed listing instead of a
  // stat + readdir + one stat per child sequence. Other failures retain their
  // original structured code; the probe never converts EACCES into ENOENT.
  try {
    const entries = await retryTransientRuntimeFs(
      () => fs.readdir(absolutePath, { withFileTypes: true }),
      signal
    );
    const shown = entries
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
      .sort()
      .slice(0, 200);
    const omitted = entries.length - shown.length;
    return {
      content: [
        {
          type: "text",
          text: shown.join("\n") + (omitted > 0 ? `\n... ${omitted} more entries omitted` : ""),
        },
      ],
      details: { path: displayPath, engine: "runtime-fs", directory: true },
    };
  } catch {
    if (signal?.aborted) throw signal.reason ?? new Error("Operation aborted");
    return null;
  }
}

function normalizeReadLocation(input: {
  path?: unknown;
  target?: unknown;
  resource?: unknown;
}): string | null {
  const raw = typeof input.path === "string" ? input.path : input.target;
  if (typeof raw !== "string" || raw.length === 0) return null;
  // Discovery and provenance tools return stable `file:<path>` references.
  // Accept them directly so the agent does not have to manually translate a
  // resource descriptor back into the read tool's path spelling.
  return raw.replace(/^file:(?:\/\/)?/iu, "");
}

function similarityScore(candidate: string, wanted: string): number {
  if (candidate === wanted) return 100;
  let score = 0;
  if (candidate.split(".").pop() === wanted.split(".").pop()) score += 10;
  const max = Math.min(candidate.length, wanted.length);
  for (let i = 0; i < max && candidate[i] === wanted[i]; i += 1) score += 2;
  for (const token of wanted.split(/[^a-z0-9]+/u)) {
    if (token && candidate.includes(token)) score += token.length;
  }
  return score;
}

function isLikelyImagePath(filePath: string): boolean {
  return /\.(?:png|jpe?g|gif|webp)$/iu.test(filePath);
}

function hasNoFileExtension(filePath: string): boolean {
  const basename = filePath.slice(filePath.lastIndexOf("/") + 1);
  return !basename.includes(".");
}

function hasSupportedImageMagic(bytes: Uint8Array): boolean {
  const png =
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47 &&
    bytes[4] === 0x0d &&
    bytes[5] === 0x0a &&
    bytes[6] === 0x1a &&
    bytes[7] === 0x0a;
  const jpeg = bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const gif =
    bytes.length >= 6 &&
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61;
  const webp =
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50;
  return png || jpeg || gif || webp;
}

function formatBoundedTextResult(bounded: FsReadTextResult, displayPath: string): ReadResult {
  if (bounded.startLine > bounded.totalLines) {
    return {
      content: [
        {
          type: "text",
          text:
            `[Offset ${bounded.startLine} is beyond end of file (${bounded.totalLines} lines total). ` +
            `The last valid offset is ${bounded.totalLines}.]`,
        },
      ],
      details: { path: displayPath, engine: "runtime-fs" },
    };
  }
  const outputLines =
    bounded.endLine >= bounded.startLine ? bounded.endLine - bounded.startLine + 1 : 0;
  const truncation: TruncationResult = {
    content: bounded.text,
    truncated: bounded.truncated,
    truncatedBy: bounded.truncatedBy ?? null,
    totalLines: bounded.totalLines,
    totalBytes: bounded.totalBytes,
    outputLines,
    outputBytes: utf8ByteLength(bounded.text),
    lastLinePartial: false,
    firstLineExceedsLimit: bounded.firstLineExceedsLimit,
    maxLines: bounded.maxLines,
    maxBytes: bounded.maxBytes,
  };
  if (bounded.firstLineExceedsLimit) {
    return {
      content: [
        {
          type: "text",
          text: `[Line ${bounded.startLine} exceeds ${formatSize(bounded.maxBytes)} limit. Use offset=${bounded.nextOffset} to skip past it.]`,
        },
      ],
      details: { path: displayPath, engine: "runtime-fs", truncation },
    };
  }
  let text = bounded.text;
  if (bounded.truncated) {
    const byteNote =
      bounded.truncatedBy === "bytes" ? ` (${formatSize(bounded.maxBytes)} limit)` : "";
    text +=
      `\n\n[Showing lines ${bounded.startLine}-${bounded.endLine} of ${bounded.totalLines}${byteNote}. ` +
      `Use offset=${bounded.nextOffset} to continue.]`;
  }
  return {
    content: [{ type: "text", text }],
    details: {
      path: displayPath,
      engine: "runtime-fs",
      ...(bounded.truncated ? { truncation } : {}),
      displayedRange: {
        coordinateKind: "utf16",
        start: bounded.start,
        end: bounded.end,
        startLine: bounded.startLine,
        endLine: bounded.endLine,
      },
    },
  };
}

function formatBoundedBytesResult(bounded: FsReadBytesResult, displayPath: string): ReadResult {
  const range = {
    start: bounded.start,
    end: bounded.end,
    totalBytes: bounded.totalBytes,
    ...(bounded.nextOffset !== undefined ? { nextOffset: bounded.nextOffset } : {}),
  };
  const payload = {
    path: displayPath,
    encoding: "base64" as const,
    range,
    base64: bounded.base64,
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload) }],
    details: {
      path: displayPath,
      engine: "runtime-fs",
      encoding: "base64",
      size: bounded.end - bounded.start,
      originalSize: bounded.totalBytes,
      byteRange: range,
    },
  };
}

function formatTextResult(
  textContent: string,
  displayPath: string,
  offset: number | undefined,
  limit: number | undefined,
  extensionFallback?: string
): {
  content: (TextContent | ImageContent)[];
  details: ReadToolDetails;
} {
  const allLines = textContent.split("\n");
  const totalFileLines = allLines.length;
  const startLine = offset ? Math.max(0, offset - 1) : 0;
  const startLineDisplay = startLine + 1;
  if (startLine >= allLines.length) {
    return {
      content: [
        {
          type: "text",
          text:
            `[Offset ${offset} is beyond end of file (${allLines.length} lines total). ` +
            `The last valid offset is ${allLines.length}.]`,
        },
      ],
      details: { path: displayPath, engine: "runtime-fs", extensionFallback },
    };
  }
  let selectedContent: string;
  let userLimitedLines: number | undefined;
  if (limit !== undefined) {
    const endLine = Math.min(startLine + limit, allLines.length);
    selectedContent = allLines.slice(startLine, endLine).join("\n");
    userLimitedLines = endLine - startLine;
  } else {
    selectedContent = allLines.slice(startLine).join("\n");
  }
  const truncation = truncateHead(selectedContent);
  const displayedStart = allLines
    .slice(0, startLine)
    .reduce((total, line) => total + line.length + 1, 0);
  const displayedEnd = displayedStart + truncation.content.length;
  const displayedEndLine = startLineDisplay + Math.max(0, truncation.outputLines - 1);
  let outputText: string;
  let details: ReadToolDetails = {};
  if (truncation.firstLineExceedsLimit) {
    const firstLineSize = formatSize(utf8ByteLength(allLines[startLine] ?? ""));
    outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use offset=${startLineDisplay + 1} to skip past it.]`;
    details = { truncation };
  } else if (truncation.truncated) {
    const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
    const nextOffset = endLineDisplay + 1;
    outputText = truncation.content;
    if (truncation.truncatedBy === "lines") {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines}. Use offset=${nextOffset} to continue.]`;
    } else {
      outputText += `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${totalFileLines} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
    }
    details = { truncation };
  } else if (userLimitedLines !== undefined && startLine + userLimitedLines < allLines.length) {
    const remaining = allLines.length - (startLine + userLimitedLines);
    const nextOffset = startLine + userLimitedLines + 1;
    outputText = truncation.content;
    outputText += `\n\n[${remaining} more lines in file. Use offset=${nextOffset} to continue.]`;
  } else {
    outputText = truncation.content;
  }
  return {
    content: [{ type: "text", text: outputText }],
    details: {
      ...details,
      path: displayPath,
      engine: "runtime-fs",
      extensionFallback,
      ...(!truncation.firstLineExceedsLimit
        ? {
            displayedRange: {
              coordinateKind: "utf16" as const,
              start: displayedStart,
              end: displayedEnd,
              startLine: startLineDisplay,
              endLine: displayedEndLine,
            },
          }
        : {}),
    },
  };
}
const TRANSIENT_RUNTIME_FS_FAILURE =
  /(?:DO dispatch fetch|fetch failed|other side closed|socket hang up|UND_ERR_SOCKET|ECONNRESET|ECONNREFUSED|ETIMEDOUT|\btransport\b)/iu;
const TRANSIENT_RUNTIME_FS_ATTEMPTS = 4;

async function retryTransientRuntimeFs<T>(
  operation: () => Promise<T>,
  signal?: AbortSignal
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= TRANSIENT_RUNTIME_FS_ATTEMPTS; attempt += 1) {
    if (signal?.aborted) throw new Error("Operation aborted");
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      if (
        attempt === TRANSIENT_RUNTIME_FS_ATTEMPTS ||
        !TRANSIENT_RUNTIME_FS_FAILURE.test(message)
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, attempt * 100));
    }
  }
  throw lastError;
}
