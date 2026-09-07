// @vitest-environment jsdom

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import {
  getVibestudioHostPlatform,
  resolveVibestudioHostPlatform,
  useIsMobile,
  useTouchDevice,
  useViewportHeight,
} from "../responsive";

// ---------------------------------------------------------------------------
// matchMedia mock — jsdom does not implement matchMedia
// ---------------------------------------------------------------------------

type MatchMediaListener = (e: { matches: boolean }) => void;

const mediaListeners = new Map<string, Set<MatchMediaListener>>();

function mockMatchMedia(query: string) {
  return {
    matches: getMediaMatches(query),
    media: query,
    addEventListener(_event: string, cb: MatchMediaListener) {
      let set = mediaListeners.get(query);
      if (!set) {
        set = new Set();
        mediaListeners.set(query, set);
      }
      set.add(cb);
    },
    removeEventListener(_event: string, cb: MatchMediaListener) {
      mediaListeners.get(query)?.delete(cb);
    },
    addListener: vi.fn(),
    removeListener: vi.fn(),
    onchange: null,
    dispatchEvent: vi.fn(),
  };
}

let mobileMatches = false;
let touchMatches = false;

function getMediaMatches(query: string): boolean {
  if (query === "(max-width: 767px)") return mobileMatches;
  if (query === "(pointer: coarse)") return touchMatches;
  return false;
}

function fireMediaChange(query: string) {
  const matches = getMediaMatches(query);
  mediaListeners.get(query)?.forEach((cb) => cb({ matches }));
}

// ---------------------------------------------------------------------------
// visualViewport mock
// ---------------------------------------------------------------------------

let mockViewportHeight = 800;
const viewportListeners = new Set<() => void>();

const mockVisualViewport = {
  get height() {
    return mockViewportHeight;
  },
  addEventListener(_event: string, cb: () => void) {
    viewportListeners.add(cb);
  },
  removeEventListener(_event: string, cb: () => void) {
    viewportListeners.delete(cb);
  },
};

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

beforeEach(() => {
  mobileMatches = false;
  touchMatches = false;
  mockViewportHeight = 800;
  mediaListeners.clear();
  viewportListeners.clear();

  vi.stubGlobal("matchMedia", mockMatchMedia);
  vi.stubGlobal("visualViewport", mockVisualViewport);
});

afterEach(() => {
  Reflect.deleteProperty(globalThis, "__vibestudioHostPlatform");
  vi.restoreAllMocks();
});

describe("Vibestudio host platform", () => {
  it("prefers the native host's explicit platform", () => {
    expect(resolveVibestudioHostPlatform("mobile")).toBe("mobile");
  });

  it("defaults ordinary hosted panels to electron chrome", () => {
    expect(resolveVibestudioHostPlatform(undefined)).toBe("electron");
  });

  it("does not derive chrome ownership from a mobile-looking user agent", () => {
    vi.stubGlobal("navigator", { userAgent: "Vibestudio-Mobile/3 Android" });
    expect(getVibestudioHostPlatform()).toBe("electron");
  });

  it("reads the bridge-injected value used by live mobile WebViews", () => {
    Object.assign(globalThis, { __vibestudioHostPlatform: "mobile" });
    expect(getVibestudioHostPlatform()).toBe("mobile");
  });
});

// ---------------------------------------------------------------------------
// useIsMobile
// ---------------------------------------------------------------------------

describe("useIsMobile", () => {
  it("returns false for wide viewport", () => {
    mobileMatches = false;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);
  });

  it("returns true for narrow viewport", () => {
    mobileMatches = true;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(true);
  });

  it("reacts to media query change", () => {
    mobileMatches = false;
    const { result } = renderHook(() => useIsMobile());
    expect(result.current).toBe(false);

    act(() => {
      mobileMatches = true;
      fireMediaChange("(max-width: 767px)");
    });
    expect(result.current).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// useTouchDevice
// ---------------------------------------------------------------------------

describe("useTouchDevice", () => {
  it("returns false for non-touch", () => {
    touchMatches = false;
    const { result } = renderHook(() => useTouchDevice());
    expect(result.current).toBe(false);
  });

  it("returns true for touch device", () => {
    touchMatches = true;
    const { result } = renderHook(() => useTouchDevice());
    expect(result.current).toBe(true);
  });

  it("reacts to media query change", () => {
    touchMatches = false;
    const { result } = renderHook(() => useTouchDevice());
    expect(result.current).toBe(false);

    act(() => {
      touchMatches = true;
      fireMediaChange("(pointer: coarse)");
    });
    expect(result.current).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// useViewportHeight
// ---------------------------------------------------------------------------

describe("useViewportHeight", () => {
  it("returns initial viewport height", () => {
    mockViewportHeight = 800;
    const { result } = renderHook(() => useViewportHeight());
    expect(result.current).toBe(800);
  });

  it("reacts to viewport resize (keyboard open)", () => {
    mockViewportHeight = 800;
    const { result } = renderHook(() => useViewportHeight());
    expect(result.current).toBe(800);

    act(() => {
      mockViewportHeight = 400;
      viewportListeners.forEach((cb) => cb());
    });
    expect(result.current).toBe(400);
  });

  it("falls back to window.innerHeight when visualViewport is absent", () => {
    vi.stubGlobal("visualViewport", undefined);
    Object.defineProperty(window, "innerHeight", {
      value: 900,
      writable: true,
    });

    const { result } = renderHook(() => useViewportHeight());
    expect(result.current).toBe(900);
  });
});
