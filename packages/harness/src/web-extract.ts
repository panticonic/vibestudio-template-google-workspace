/**
 * Web extraction utilities — re-exported as a panel-safe subpath.
 *
 * Panel-side eval (the `eval` tool sandbox) needs HTML→markdown when
 * routing fetches through a Playwright-controlled browser panel. The
 * main `@workspace/harness` entry pulls in worker-only modules
 * (pi-agent-core, ws, etc); this entry point only re-exports the pure
 * extraction functions (linkedom + readability) so panels can import
 * them without dragging the worker bundle.
 */

export {
  htmlToReadableMarkdown,
  extractPage,
  type ExtractedPage,
  type ExtractFetcher,
} from "./web/extract.js";
