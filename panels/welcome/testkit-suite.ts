import {
  suite,
  withPanel,
  waitForText,
  waitFor,
  evalInPanel,
  expect,
  setViewport,
  audit,
} from "@workspace/testkit";

export const googleSetupJourney = suite("google-setup-journey", {
  timeoutMs: 120_000,
  usesPanelAutomation: true,
}).test(
  "explains account prerequisites, routes to setup owners and retains a truthful gate after reload",
  async (t) => {
    await withPanel(
      "panels/welcome",
      async (handle) => {
        await waitForText(handle, "Your Gmail assistant");
        await waitFor(
          () =>
            evalInPanel<boolean>(
              handle,
              '!document.body.textContent.includes("Checking your Google connection…")',
            ),
          { label: "initial account observation settles" },
        );
        expect(
          await evalInPanel<boolean>(
            handle,
            'Array.from(document.querySelectorAll("a")).some(a=>a.textContent==="Manage connected accounts")',
          ),
          "account owner navigation",
        ).toBe(true);
        expect(
          await evalInPanel<boolean>(
            handle,
            'Array.from(document.querySelectorAll("a")).some(a=>a.textContent==="Review saved permissions")',
          ),
          "permission owner navigation",
        ).toBe(true);
        const before = await evalInPanel<boolean>(
          handle,
          'Boolean(Array.from(document.querySelectorAll("a")).find(a=>a.textContent==="Open Gmail")?.getAttribute("href"))',
        );
        await handle.reload();
        await waitForText(handle, "Your Gmail assistant");
        await waitFor(
          () =>
            evalInPanel<boolean>(
              handle,
              '!document.body.textContent.includes("Checking your Google connection…")',
            ),
          { label: "reopened account observation settles" },
        );
        expect(
          await evalInPanel<boolean>(
            handle,
            'Boolean(Array.from(document.querySelectorAll("a")).find(a=>a.textContent==="Open Gmail")?.getAttribute("href"))',
          ),
          "account readiness re-observed after reload",
        ).toBe(before);
        for (const width of [320, 390, 1280]) {
          await setViewport(handle, { width, height: 844 });
          expect(
            (await audit(handle)).horizontalOverflow,
            `setup layout at ${width}`,
          ).toBe(false);
        }
        t.log(
          "Google setup observation and gate restored; no account consent or mail effect was requested.",
        );
      },
      { focus: false },
    );
  },
);
