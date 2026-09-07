/**
 * Chat transcript suite — in-system port of tests/e2e/flows/chatTranscript.spec.ts.
 *
 * Opens panels/chat wired to the deterministic test agent
 * (workers/test-agent), then asserts the transcript renders the initial
 * prompt, an eval tool bead that transitions pending → complete, and the
 * deterministic agent reply — without raw tool-call/JSON leakage.
 */
import { suite } from "../run.js";
import { expect } from "../expect.js";
import { evalInPanel, panelText, waitFor, waitForText, withPanel } from "../panels.js";

const INITIAL_PROMPT = "Testkit initial prompt for the chat transcript suite";
const AGENT_REPLY = "Deterministic agent reply from the test worker.";

const CHAT_STATE_ARGS = {
  initialPrompt: INITIAL_PROMPT,
  agentSource: "workers/test-agent",
  agentClass: "TestAgentWorker",
  agentConfig: {
    deterministicResponse: true,
    responseText: AGENT_REPLY,
    code: "read('skills/onboarding/SKILL.md')",
    delayMs: 500,
  },
};

export const chatTranscript = suite("chat-transcript", {
  timeoutMs: 120_000,
  usesPanelAutomation: true,
})
  .test("renders prompt, eval bead pending→complete, and agent reply", async () =>
    withPanel(
      "panels/chat",
      async (handle) => {
        await waitForText(handle, INITIAL_PROMPT, { timeoutMs: 60_000 });
        // The eval invocation bead must reach "complete" (it may already be
        // complete by the first observation — pending is transient).
        await waitFor(
          () =>
            evalInPanel<boolean>(
              handle,
              `Boolean(document.querySelector('[data-invocation-name="eval"][data-invocation-status="complete"]'))`
            ),
          { timeoutMs: 60_000, label: "eval bead complete" }
        );
        await waitForText(handle, AGENT_REPLY, { timeoutMs: 60_000 });

        const finalText = await panelText(handle);
        expect(finalText, "tool bead label").toContain("Eval");
        expect(finalText, "raw tool-call leakage").not.toContain("[tool call:");
        expect(finalText, "raw eval console leakage").not.toContain("[eval] Console:");
        expect(finalText, "raw result JSON leakage").not.toContain('{"ok":true}');
      },
      { stateArgs: CHAT_STATE_ARGS }
    )
  )
  .test("forks from a message, scopes the annotation, and navigates to the parent", async () =>
    withPanel(
      "panels/chat",
      async (handle) => {
        const page = await handle.cdp.page();
        await waitForText(handle, AGENT_REPLY, { timeoutMs: 60_000 });
        await waitFor(
          () =>
            evalInPanel<boolean>(
              handle,
              `(() => {
                  const button = document.querySelector('button[aria-label="Switch fork"]');
                  return Boolean(button?.textContent?.includes("Main"));
                })()`
            ),
          { timeoutMs: 60_000, label: "main branch control" }
        );

        await page.getByRole("button", { name: "Message actions" }).last().click();
        await page.getByRole("menuitem", { name: "Fork from here", exact: true }).click();

        try {
          await waitFor(
            () =>
              evalInPanel<boolean>(
                handle,
                `(() => {
                    const button = document.querySelector('button[aria-label="Switch fork"]');
                    return Boolean(button?.textContent?.includes("After"));
                  })()`
              ),
            { timeoutMs: 30_000, label: "fork branch becomes current" }
          );
        } catch (cause) {
          const visible = await panelText(handle).catch((error) => `<snapshot failed: ${error}>`);
          const history = await handle.cdp
            .consoleHistory()
            .catch((error) => ({ errors: [`<console history failed: ${error}>`] }));
          throw new Error(
            `${cause instanceof Error ? cause.message : String(cause)}; ` +
              `visible=${JSON.stringify(visible)}; consoleErrors=${JSON.stringify(history.errors)}`,
            { cause }
          );
        }
        const childText = await panelText(handle);
        expect(childText, "child fork creation error").not.toContain("Could not create fork");
        expect(childText, "inherited parent fork annotation").not.toContain(
          "forked this conversation from message"
        );

        // Context navigation rematerializes the panel in the same slot, which
        // intentionally retires the previous CDP target. Reconnect before
        // interacting with the newly loaded child panel.
        const childPage = await handle.cdp.page();
        await childPage.getByRole("button", { name: "Switch fork" }).click();
        await childPage.getByRole("menuitem", { name: /Parent conversation/ }).click();
        await waitFor(
          () =>
            evalInPanel<boolean>(
              handle,
              `(() => {
                  const button = document.querySelector('button[aria-label="Switch fork"]');
                  return Boolean(button?.textContent?.includes("Main"));
                })()`
            ),
          { timeoutMs: 60_000, label: "parent branch becomes current" }
        );
        await waitForText(handle, /forked this conversation from message/i, {
          timeoutMs: 30_000,
        });
        const parentText = await panelText(handle);
        expect(parentText, "parent navigation error").not.toContain(
          "Could not switch conversations"
        );
      },
      { stateArgs: CHAT_STATE_ARGS }
    )
  );
