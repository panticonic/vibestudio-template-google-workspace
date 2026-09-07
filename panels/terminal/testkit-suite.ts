/**
 * Terminal suite — in-system port of the portable half of
 * tests/e2e/flows/terminalStartup.spec.ts: the terminal panel boots its
 * xterm UI without console errors. The full pty/approval startup flow stays
 * outside (the approval prompt is shell-level UI).
 */
import { evalInPanel, expect, suite, waitFor, withPanel } from "@workspace/testkit";

export const terminal = suite("terminal", { timeoutMs: 90_000 }).test(
  "terminal panel renders xterm without console errors",
  async (t) =>
    withPanel("panels/terminal", async (handle) => {
      await waitFor(
        () =>
          evalInPanel<boolean>(
            handle,
            `Boolean(document.querySelector(".xterm, [class*='xterm']"))`
          ),
        { timeoutMs: 60_000, label: "xterm mounted" }
      );
      const history = await handle.cdp.consoleHistory();
      const startupErrors = history.errors.filter((entry) =>
        /\b(uncaught|typeerror|referenceerror|renderservice|onrequestredraw)\b/i.test(entry.message)
      );
      if (startupErrors.length > 0) {
        t.log(startupErrors.map((entry) => entry.message.slice(0, 200)).join("\n"));
      }
      expect(startupErrors.length, "terminal startup console errors").toBe(0);
    })
);
