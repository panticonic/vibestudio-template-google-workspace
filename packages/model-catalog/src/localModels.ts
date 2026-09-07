/**
 * Serializable protocol exposed by a local-model service implementation.
 *
 * The model catalog, onboarding, and chat surfaces consume this contract
 * without depending on the optional implementation that happens to provide it.
 * Secret material is intentionally absent except from LoopbackAuth, whose
 * service method is separately caller-gated.
 */

export type GpuVendor = "nvidia" | "amd" | "intel" | "apple";
export type EngineBackend = "cuda-12.4" | "cuda-13.3" | "vulkan" | "rocm" | "metal" | "cpu";

export interface GpuInfo {
  vendor: GpuVendor;
  name: string;
  vramMB: number;
  backend: EngineBackend;
  discrete: boolean;
  deviceSelector?: string;
}

export type HardwareTier = "gpu-large" | "gpu-mid" | "gpu-small" | "cpu-strong" | "cpu-min";

export interface HardwareProfile {
  os: "linux" | "darwin" | "win32";
  arch: "x64" | "arm64";
  gpus: GpuInfo[];
  cpu: { cores: number; features: string[] };
  ramMB: number;
  usableRamMB: number;
  chosenBackend: EngineBackend;
  chosenGpu: GpuInfo | null;
  tier: HardwareTier;
  probedAt: number;
  notes: string[];
}

export interface EnginePin {
  buildTag: string;
  checksums: Record<string, string>;
}

export interface InstalledEngine {
  buildTag: string;
  backend: EngineBackend;
  dir: string;
  serverBinPath: string;
  smokeTestedAt: number;
}

export interface EngineState {
  pin: EnginePin;
  cpu: InstalledEngine | null;
  gpu: InstalledEngine | null;
  degradedReason: string | null;
}

export type QuantName =
  | "Q4_0"
  | "Q4_K_M"
  | "Q5_K_M"
  | "Q6_K"
  | "Q8_0"
  | "BF16"
  | "F16"
  | (string & {});

export interface ModelRuntimeConfig {
  contextLength: number | null;
  gpuLayers: number | null;
}

export interface ModelBenchmarkResult {
  tokensPerSec: number;
  measuredAt: number;
}

export interface ModelRecord {
  slug: string;
  displayName: string;
  hfRepo: string | null;
  file: string;
  sizeBytes: number;
  quant: QuantName;
  paramCount: string;
  arch: string;
  trainedContextLength: number;
  toolsCapable: boolean;
  /** Missing only on records created before reasoning-capability inspection. */
  reasoningCapable?: boolean;
  sha256: string;
  importedInPlace: boolean;
  config: ModelRuntimeConfig;
  benchmark?: ModelBenchmarkResult | null;
  runtimeValidation?: {
    status: "pending" | "ready" | "error";
    error: string | null;
    validatedAt: number | null;
  };
  addedAt: number;
}

export type FitClass = "full-gpu" | "partial-offload" | "cpu-only" | "too-big";

export interface FitEstimate {
  fit: FitClass;
  estTokensPerSec: number | null;
  contextLength: number;
  gpuLayers: number;
  notes: string[];
}

export interface CuratedModel {
  slug: string;
  displayName: string;
  hfRepo: string;
  quantByTier: Partial<Record<HardwareTier, QuantName>>;
  sha256ByQuant: Record<string, string>;
  toolsCapable: boolean;
  blurb: string;
}

export type DownloadPhase = "active" | "queued" | "paused";

export interface DownloadJob {
  id: string;
  slug: string;
  hfRepo: string;
  file: string;
  totalBytes: number | null;
  receivedBytes: number;
  phase: DownloadPhase;
  error: string | null;
}

export type ServerKind = "utility" | "main";

export type ServerState =
  | { state: "stopped" }
  | { state: "starting" }
  | { state: "running"; port: number; loadedModels: string[]; uptimeMs: number }
  | { state: "backoff"; attempt: number; nextRetryMs: number }
  | { state: "error"; message: string; logTail: string[] };

export interface OwnerInfo {
  schemaVersion: 1;
  pid: number;
  bootId: string;
  ports: { utility: number; main: number };
  adminPort?: number;
  workspaceId: string;
  since: number;
  serverPids?: { utility?: number; main?: number };
}

export type OwnershipRole = "owner" | "attached";

export interface LocalModelsStatus {
  role: OwnershipRole;
  owner: OwnerInfo | null;
  hardware: HardwareProfile | null;
  engine: EngineState | null;
  servers: Record<ServerKind, ServerState>;
  fallback: {
    ready: boolean;
    warm: boolean;
    modelRef: string;
    downloadSizeBytes: number;
    reason: string | null;
  };
  downloads: DownloadJob[];
  storageRoot: string;
  diskFreeBytes: number;
}

export interface LocalModelEntry {
  slug: string;
  displayName: string;
  baseUrl: string;
  server: ServerKind;
  contextWindow: number;
  maxTokens: number;
  toolsCapable: boolean;
  reasoningCapable: boolean;
  fit: FitEstimate;
  measuredTokensPerSec: number | null;
  state: "ready" | "startable" | "not-installed" | "starting" | "downloading" | "error";
  download: {
    progress: number;
    phase: DownloadPhase;
    receivedBytes: number;
    totalBytes: number | null;
  } | null;
  errorMessage: string | null;
}

export interface LoopbackAuth {
  apiKey: string;
}

export interface CatalogHit {
  hfRepo: string;
  displayName: string;
  files: Array<{ file: string; quant: QuantName; sizeBytes: number }>;
  curated: CuratedModel | null;
  fitByQuant: Record<string, FitEstimate>;
}

export type LocalModelsEvent =
  | { kind: "models.changed" }
  | { kind: "download.progress"; job: DownloadJob }
  | { kind: "server.state"; server: ServerKind; state: ServerState };

export interface LocalModelsPanelTarget {
  source: string;
  stateArgs?: Record<string, unknown>;
}

export interface LocalModelsCapabilities {
  managementPanel: LocalModelsPanelTarget;
  serverLogs: Record<ServerKind, LocalModelsPanelTarget>;
}
