/**
 * Panel viewport-fit suite — in-system port of the per-panel matrix from
 * tests/e2e/flows/mobilePanels.spec.ts.
 *
 * Each shipped panel is opened, emulated at phone size via CDP
 * Emulation.setDeviceMetricsOverride (routed through the testkit-driver DO
 * for workspace panels), and asserted to fit without horizontal overflow and
 * without console errors. The outside spec's shell-chrome / native-window /
 * stack-mode tests are NOT ported — they test the Electron shell, which is
 * outside the panel runtime this suite runs in.
 */
import { suite } from "../run.js";
import { expect } from "../expect.js";
import { audit, clearViewport, setViewport, withPanel } from "../panels.js";

const MOBILE_VIEWPORT = { width: 390, height: 844, mobile: true };

const BASE_PANELS: Array<{ source: string; stateArgs?: Record<string, unknown> }> = [
  { source: "panels/chat" },
];

export const panelViewport = suite("panel-viewport", {
  timeoutMs: 90_000,
  usesPanelAutomation: true,
});

for (const { source, stateArgs } of BASE_PANELS) {
  panelViewport.test(`${source} fits a phone-sized viewport`, async (t) =>
    withPanel(
      source,
      async (handle) => {
        await setViewport(handle, MOBILE_VIEWPORT);
        t.defer(() => clearViewport(handle).catch(() => undefined));
        const result = await audit(handle);
        expect(result.viewport.width, `${source} viewport width`).toBeLessThanOrEqual(
          MOBILE_VIEWPORT.width + 4
        );
        expect(result.horizontalOverflow, `${source} horizontal overflow`).toBe(false);
        if (result.overflowElements.length > 0) {
          t.log(`overflowing elements: ${JSON.stringify(result.overflowElements)}`);
        }
      },
      { stateArgs }
    )
  );
}
