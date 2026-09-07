/**
 * Shared Zod schemas for standard agentic tools.
 *
 * These schemas define the API contract for tools that can be exposed via pubsub RPC.
 * They ensure compatibility between:
 * - Panel implementations (providers)
 * - Worker tool definitions (consumers)
 * - Claude Agent expected tool APIs
 */

import { z } from "zod";
import { normalizeToolName } from "./tool-name-utils.js";

// ============================================================================
// Shell Operations
// ============================================================================

/**
 * bash - Execute a shell command
 * Matches Claude Agent `Bash` tool behavior
 */
export const BashArgsSchema = z.object({
  command: z.string().describe("The bash command to execute"),
  description: z.string().optional().describe("Description of what the command does"),
  run_in_background: z.boolean().optional().describe("Run command in background"),
}).passthrough().superRefine((value, ctx) => {
  if ("timeout" in value) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: "Bash does not accept a timeout parameter",
      path: ["timeout"],
    });
  }
});
export type BashArgs = z.infer<typeof BashArgsSchema>;

// ============================================================================
// Plan Mode Tools
// ============================================================================

/**
 * Allowed prompt for bash permissions requested during plan mode exit.
 * These are semantic descriptions of actions, not literal commands.
 */
export const AllowedPromptSchema = z.object({
  tool: z.literal("Bash"),
  prompt: z.string().describe("Semantic description of the action, e.g. 'run tests', 'install dependencies'"),
});
export type AllowedPrompt = z.infer<typeof AllowedPromptSchema>;

/**
 * exit_plan_mode - Exit plan mode and request approval to proceed
 * Matches Claude Agent `ExitPlanMode` tool behavior.
 *
 * When Claude exits plan mode, it can optionally request bash permissions
 * that will be auto-approved during implementation.
 *
 * Note: The SDK may pass additional undocumented fields like planFilePath.
 * We accept those via passthrough() to display them in the UI.
 */
export const ExitPlanModeArgsSchema = z.object({
  allowedPrompts: z.array(AllowedPromptSchema).optional()
    .describe("Bash permissions needed to implement the plan"),
}).passthrough(); // Accept additional SDK fields like planFilePath

export type ExitPlanModeArgs = z.infer<typeof ExitPlanModeArgsSchema> & {
  /** Path to the plan file (may be passed by SDK) */
  planFilePath?: string;
  /** The plan content itself (Markdown) */
  plan?: string;
};

/**
 * enter_plan_mode - Enter plan mode for exploration and planning
 * Matches Claude Agent `EnterPlanMode` tool behavior.
 *
 * When Claude enters plan mode, it switches to read-only exploration
 * and creates a plan file for user review.
 */
export const EnterPlanModeArgsSchema = z.object({}).passthrough();

export type EnterPlanModeArgs = z.infer<typeof EnterPlanModeArgsSchema>;

// ============================================================================
// Type Checking Tools
// ============================================================================

/**
 * check_types - Run TypeScript type checking on panel/worker files
 * Returns diagnostics (errors, warnings) from the TypeScript compiler
 */
export const CheckTypesArgsSchema = z.object({
  panel_path: z.string().describe(
    'Relative path to the panel/worker root (e.g. "panels/my-panel")'
  ),
  file_path: z.string().optional().describe("Specific file within the panel to check (checks all if omitted)"),
});
export type CheckTypesArgs = z.infer<typeof CheckTypesArgsSchema>;

/**
 * get_type_info - Get TypeScript type information at a position
 * Useful for understanding types and getting documentation
 */
export const GetTypeInfoArgsSchema = z.object({
  panel_path: z.string().describe('Relative path to the panel/worker root (e.g. "panels/my-panel")'),
  file_path: z.string().describe("File path relative to the panel root"),
  line: z.number().describe("Line number (1-indexed)"),
  column: z.number().describe("Column number (1-indexed)"),
});
export type GetTypeInfoArgs = z.infer<typeof GetTypeInfoArgsSchema>;

/**
 * get_completions - Get code completions at a position
 */
export const GetCompletionsArgsSchema = z.object({
  panel_path: z.string().describe('Relative path to the panel/worker root (e.g. "panels/my-panel")'),
  file_path: z.string().describe("File path relative to the panel root"),
  line: z.number().describe("Line number (1-indexed)"),
  column: z.number().describe("Column number (1-indexed)"),
});
export type GetCompletionsArgs = z.infer<typeof GetCompletionsArgsSchema>;

// ============================================================================
// Project Management Tools
// ============================================================================

/**
 * create_project - Scaffold a new workspace project (panel, package, skill, agent)
 */
export const CreateProjectArgsSchema = z.object({
  type: z.enum(["panel", "package", "skill", "agent"]).describe("Project type to scaffold"),
  name: z.string().describe("Directory name and package name suffix (e.g. 'my-app')"),
  title: z.string().optional().describe("Human-readable title (defaults to name)"),
});
export type CreateProjectArgs = z.infer<typeof CreateProjectArgsSchema>;

/**
 * run_tests - Run vitest tests on a workspace panel or package
 */
export const RunTestsArgsSchema = z.object({
  target: z.string().describe('Relative path to panel/package (e.g. "panels/my-app")'),
  file: z.string().optional().describe("Specific test file within the target"),
  test_name: z.string().optional().describe("Filter by test name pattern"),
});
export type RunTestsArgs = z.infer<typeof RunTestsArgsSchema>;

/**
 * vcs - Workspace VCS operations on the current context state.
 */
export const VcsArgsSchema = z.object({
  operation: z.enum(["status", "diff", "commit", "log"]).describe(
    "Workspace VCS operation to perform. Commit snapshots the context state and triggers auto-build."
  ),
  path: z.string().optional().describe("Relative path within workspace (default: repository root)"),
  message: z.string().optional().describe('Commit message (required for "commit")'),
});
export type VcsArgs = z.infer<typeof VcsArgsSchema>;

// ============================================================================
// Rich Preview Support
// ============================================================================

/**
 * Tools that have rich preview support in the UI (snake_case pubsub format).
 * Used by worker-base.ts to determine whether to use toolPreview or code field.
 */
export const RICH_PREVIEW_TOOLS = [
  "bash",
  "enter_plan_mode",
  "exit_plan_mode",
] as const;

export type RichPreviewToolName = (typeof RICH_PREVIEW_TOOLS)[number];

/**
 * Check if a tool has rich preview support.
 * Accepts any naming format and normalizes before checking.
 *
 * @param toolName - Tool name in any format (prefixed, PascalCase, or snake_case)
 * @returns True if the tool has rich preview support
 */
export function hasRichPreview(toolName: string): boolean {
  const normalized = normalizeToolName(toolName);
  return (RICH_PREVIEW_TOOLS as readonly string[]).includes(normalized);
}

// ============================================================================
// Type Guards for Tool Arguments
// ============================================================================

/**
 * Type guards for rich preview tool arguments.
 * These use Zod schemas for validation, ensuring consistency with the schema definitions.
 */

export function isExitPlanModeArgs(args: unknown): args is ExitPlanModeArgs {
  return ExitPlanModeArgsSchema.safeParse(args).success;
}

export function isEnterPlanModeArgs(args: unknown): args is EnterPlanModeArgs {
  return EnterPlanModeArgsSchema.safeParse(args).success;
}

export function isBashArgs(args: unknown): args is BashArgs {
  return BashArgsSchema.safeParse(args).success;
}
