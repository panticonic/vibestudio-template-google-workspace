/**
 * Action description generation for tool use display.
 */

import { prettifyToolName } from "./tool-name-utils.js";

/**
 * Truncate a file path for display, keeping the filename visible.
 */
function truncatePathForAction(path: string, maxLen = 40): string {
  if (path.length <= maxLen) return path;
  const parts = path.split("/");
  const filename = parts.pop() || "";
  if (filename.length >= maxLen - 3) return "..." + filename.slice(-(maxLen - 3));
  return "..." + path.slice(-(maxLen - 3));
}

/**
 * Truncate a string for display.
 */
function truncateStrForAction(str: string, maxLen: number): string {
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - 3) + "...";
}

/**
 * Generate informative action descriptions based on tool name and input.
 * Used by all responder workers for consistent action display.
 *
 * @example
 * ```typescript
 * getDetailedActionDescription("Read", { file_path: "/src/index.ts" })
 * // => "Reading index.ts"
 *
 * getDetailedActionDescription("pubsub_panel_eval", { code: "console.log('hi')" })
 * // => "Calling panel.eval"
 * ```
 */
export function getDetailedActionDescription(
  toolName: string,
  input: Record<string, unknown>
): string {
  // Normalize tool name to canonical PascalCase form.
  // Handles raw SDK names ("Read"), MCP names ("mcp__workspace__file_read"),
  // and pubsub names ("pubsub_abc123_file_read") uniformly.
  const canonical = prettifyToolName(toolName);

  switch (canonical) {
    case "Read":
      return input["file_path"]
        ? `Reading ${truncatePathForAction(input["file_path"] as string)}`
        : "Reading file";

    case "Write":
      return input["file_path"]
        ? `Writing to ${truncatePathForAction(input["file_path"] as string)}`
        : "Writing file";

    case "Edit":
      return input["file_path"]
        ? `Editing ${truncatePathForAction(input["file_path"] as string)}`
        : "Editing file";

    case "Bash":
      return input["command"]
        ? `Running: ${truncateStrForAction(input["command"] as string, 50)}`
        : "Running command";

    case "Glob":
      return input["pattern"]
        ? `Finding files: ${truncateStrForAction(input["pattern"] as string, 40)}`
        : "Searching for files";

    case "Grep": {
      const grepPath = input["path"] ? ` in ${truncatePathForAction(input["path"] as string, 20)}` : "";
      return input["pattern"]
        ? `Searching for '${truncateStrForAction(input["pattern"] as string, 25)}'${grepPath}`
        : "Searching file contents";
    }

    case "WebSearch":
      return input["query"]
        ? `Searching: ${truncateStrForAction(input["query"] as string, 40)}`
        : "Searching the web";

    case "WebFetch":
      return input["url"]
        ? `Fetching: ${truncateStrForAction(input["url"] as string, 40)}`
        : "Fetching web content";

    case "Task":
      return input["description"]
        ? `Task: ${truncateStrForAction(input["description"] as string, 40)}`
        : "Delegating to subagent";

    case "TodoWrite":
      return "Updating task list";

    case "AskUserQuestion": {
      const questions = input["questions"];
      if (questions && Array.isArray(questions) && questions.length > 0) {
        const firstQuestion = questions[0] as { question?: string };
        return firstQuestion.question
          ? `Asking: ${truncateStrForAction(firstQuestion.question, 35)}`
          : "Asking user";
      }
      return "Asking user";
    }

    case "NotebookEdit":
      return input["notebook_path"]
        ? `Editing notebook: ${truncatePathForAction(input["notebook_path"] as string)}`
        : "Editing notebook";

    case "KillShell":
      return input["shell_id"]
        ? `Killing shell: ${input["shell_id"]}`
        : "Killing shell";

    // MCP channel/attachment tools
    case "SetTitle":
      return input["title"]
        ? `Setting title: ${truncateStrForAction(input["title"] as string, 40)}`
        : "Setting conversation title";

    case "ListImages":
      return "Listing available images";

    case "GetImage":
      return "Viewing image";

    case "GetCurrentImages":
      return "Getting current images";

    // Plan mode tools
    case "EnterPlanMode":
      return "Entering plan mode";

    case "ExitPlanMode":
      return "Exiting plan mode";

    // Skill invocation
    case "Skill":
      return input["skill"]
        ? `Running skill: ${truncateStrForAction(input["skill"] as string, 30)}`
        : "Running skill";

    // Git tools (canonical names from CANONICAL_TOOL_MAPPINGS)
    case "GitStatus":
      return "Checking git status";
    case "GitDiff":
      return "Getting git diff";
    case "GitLog":
      return "Viewing git log";
    case "GitAdd":
      return input["files"]
        ? `Staging: ${truncateStrForAction(String(input["files"]), 40)}`
        : "Staging files";
    case "GitCommit":
      return input["message"]
        ? `Committing: ${truncateStrForAction(input["message"] as string, 40)}`
        : "Creating commit";
    case "GitCheckout":
      return input["branch"]
        ? `Checking out: ${input["branch"]}`
        : "Checking out";

    // Directory tools
    case "Tree":
    case "ListDirectory":
      return input["path"]
        ? `Listing ${truncatePathForAction(input["path"] as string)}`
        : "Listing directory";

    // Type checking tools
    case "CheckTypes":
      return "Checking types";
    case "GetTypeInfo":
      return "Getting type info";
    case "GetCompletions":
      return "Getting completions";

    // Remove tool
    case "Remove":
      return input["path"]
        ? `Removing ${truncatePathForAction(input["path"] as string)}`
        : "Removing file";

    // Panel eval/feedback (operational -- no tool use)
    case "Eval":
      return "Evaluating code";
    case "FeedbackForm":
      return "Showing form";
    case "FeedbackCustom":
      return "Showing custom UI";

    default:
      return `Using ${canonical}`;
  }
}
