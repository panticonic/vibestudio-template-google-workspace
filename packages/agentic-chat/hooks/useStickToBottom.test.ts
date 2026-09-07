import { describe, expect, it } from "vitest";
import { decidePin, type ScrollSample } from "./useStickToBottom.js";

const THRESHOLD = 32;
const VIEWPORT = 500;

/** Build a sample for a viewport of fixed height scrolled to `scrollTop`. */
function sample(scrollTop: number, scrollHeight: number): ScrollSample {
  return { scrollTop, scrollHeight, clientHeight: VIEWPORT };
}

describe("decidePin", () => {
  it("pins when the view is within the bottom sticky zone", () => {
    // 1000px content, viewport 500 → bottom is scrollTop 500. Within 32px.
    expect(decidePin(sample(480, 1000), sample(490, 1000), THRESHOLD)).toBe("pin");
    expect(decidePin(sample(500, 1000), sample(500, 1000), THRESHOLD)).toBe("pin");
  });

  it("releases on a deliberate upward scroll away from the bottom", () => {
    // Was at bottom (500), user scrolls up to 300; height unchanged.
    expect(decidePin(sample(500, 1000), sample(300, 1000), THRESHOLD)).toBe("release");
  });

  it("never pins from content growth alone while released", () => {
    // Released and reading at 300; content grows below (height 1000 → 1400),
    // scrollTop unchanged. This is the streaming case that used to yank down.
    expect(decidePin(sample(300, 1000), sample(300, 1400), THRESHOLD)).toBe("keep");
  });

  it("keeps the pin through a programmatic scroll-to-bottom", () => {
    // Pinned; content grew and we scrolled to the new bottom (downward move).
    expect(decidePin(sample(500, 1000), sample(900, 1400), THRESHOLD)).toBe("pin");
  });

  it("does not release on a shrink-clamp that moves scrollTop upward", () => {
    // Pinned at the bottom of 2000px content; content shrinks to 1000px, so the
    // browser clamps scrollTop from 1500 down to 500. Looks like an upward
    // scroll, but it lands back in the bottom zone → pin, not release.
    expect(decidePin(sample(1500, 2000), sample(500, 1000), THRESHOLD)).toBe("pin");
  });

  it("does not release for a large shrink that clamps outside the zone", () => {
    // A shrink that leaves us above the sticky zone must still not be read as a
    // user gesture (height shrank), so the pin is preserved by the resize path.
    expect(decidePin(sample(1500, 5000), sample(1500, 3000), THRESHOLD)).toBe("keep");
  });

  it("ignores sub-pixel upward jitter", () => {
    expect(decidePin(sample(300, 1000), sample(299.5, 1000), THRESHOLD)).toBe("keep");
  });

  it("keeps state when scrolling down but still short of the bottom zone", () => {
    expect(decidePin(sample(200, 2000), sample(400, 2000), THRESHOLD)).toBe("keep");
  });
});
