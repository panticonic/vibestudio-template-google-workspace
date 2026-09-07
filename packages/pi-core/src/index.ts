/**
 * @workspace/pi-core — vendored subset of @earendil-works/pi-agent-core v0.82.0.
 *
 * This barrel mirrors the upstream `dist/index.js`, restricted to the vendored
 * modules (see PROVENANCE.md). Intentionally NOT exported: agent.ts (Agent),
 * agent-loop.ts (runAgentLoop await chain), harness/agent-harness.ts
 * (AgentHarness), Jsonl/file session repos, proxy.ts, node.ts.
 */

// Top-level agent types (AgentMessage, AgentTool, AgentEvent, ThinkingLevel, ...)
export * from "./vendor/types.js";

// Harness types (Result, errors, SessionStorage/SessionRepo/SessionTreeEntry,
// Skill, PromptTemplate, ExecutionEnv, AgentHarness* event/option types, ...)
export * from "./vendor/harness/types.js";

// Compaction (pure functions)
export {
  calculateContextTokens,
  compact,
  DEFAULT_COMPACTION_SETTINGS,
  estimateContextTokens,
  estimateTokens,
  findCutPoint,
  findTurnStartIndex,
  generateSummary,
  getLastAssistantUsage,
  prepareCompaction,
  serializeConversation,
  shouldCompact,
} from "./vendor/harness/compaction/compaction.js";
export type {
  CompactionPreparation,
  CompactionResult,
  CompactionSettings,
} from "./vendor/harness/compaction/compaction.js";
export {
  collectEntriesForBranchSummary,
  generateBranchSummary,
  prepareBranchEntries,
} from "./vendor/harness/compaction/branch-summarization.js";
export type {
  BranchPreparation,
  BranchSummaryDetails,
  CollectEntriesResult,
} from "./vendor/harness/compaction/branch-summarization.js";

// Session tree (Session, buildSessionContext) and in-memory repo/storage
export * from "./vendor/harness/session/session.js";
export * from "./vendor/harness/session/memory-repo.js";
export * from "./vendor/harness/session/repo-utils.js";
export { uuidv7 } from "@workspace/pi-ai";

// Message constructors (compaction/branch-summary/custom messages)
export * from "./vendor/harness/messages.js";

// System prompt, skills, prompt templates
export * from "./vendor/harness/system-prompt.js";
export * from "./vendor/harness/skills.js";
export * from "./vendor/harness/prompt-templates.js";

// Small pure utilities (exported by the upstream barrel)
export * from "./vendor/harness/utils/shell-output.js";
export * from "./vendor/harness/utils/truncate.js";
