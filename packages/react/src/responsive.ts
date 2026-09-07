/**
 * Responsive utility hooks for mobile-readiness.
 *
 * - useIsMobile()       — viewport width < 768px (behavior branching)
 * - useTouchDevice()    — pointer: coarse (input modality branching)
 * - useViewportHeight() — reactive visual viewport height (keyboard-aware)
 * - getVibestudioHostPlatform() — trusted outer-shell presentation owner
 */

import { useSyncExternalStore } from "react";

export type VibestudioHostPlatform = "mobile" | "electron";

export function resolveVibestudioHostPlatform(
  explicitPlatform: unknown,
): VibestudioHostPlatform {
  if (explicitPlatform === "mobile") return "mobile";
  return "electron";
}

/**
 * Resolve the trusted shell that owns this panel's outer chrome. The native
 * mobile WebView injects an explicit value before userland executes. Absence is
 * the desktop/headless contract; user-agent strings carry no authority.
 */
export function getVibestudioHostPlatform(): VibestudioHostPlatform {
  return resolveVibestudioHostPlatform(
    (globalThis as { __vibestudioHostPlatform?: unknown })
      .__vibestudioHostPlatform,
  );
}

// ---------------------------------------------------------------------------
// useIsMobile
// ---------------------------------------------------------------------------

const MOBILE_QUERY = "(max-width: 767px)";

function subscribeMobile(cb: () => void) {
  const mql = window.matchMedia(MOBILE_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getMobileSnapshot(): boolean {
  return window.matchMedia(MOBILE_QUERY).matches;
}

function getMobileServerSnapshot(): boolean {
  return false;
}

/** True when viewport width < 768px. For behavior branching, not layout. */
export function useIsMobile(): boolean {
  return useSyncExternalStore(
    subscribeMobile,
    getMobileSnapshot,
    getMobileServerSnapshot,
  );
}

// ---------------------------------------------------------------------------
// useTouchDevice
// ---------------------------------------------------------------------------

const TOUCH_QUERY = "(pointer: coarse)";

function subscribeTouch(cb: () => void) {
  const mql = window.matchMedia(TOUCH_QUERY);
  mql.addEventListener("change", cb);
  return () => mql.removeEventListener("change", cb);
}

function getTouchSnapshot(): boolean {
  return window.matchMedia(TOUCH_QUERY).matches;
}

function getTouchServerSnapshot(): boolean {
  return false;
}

/** True when primary pointer is coarse (touch). For hover-vs-always-visible decisions. */
export function useTouchDevice(): boolean {
  return useSyncExternalStore(
    subscribeTouch,
    getTouchSnapshot,
    getTouchServerSnapshot,
  );
}

// ---------------------------------------------------------------------------
// useViewportHeight
// ---------------------------------------------------------------------------

function subscribeViewportHeight(cb: () => void) {
  const vv = window.visualViewport;
  if (vv) {
    vv.addEventListener("resize", cb);
    return () => vv.removeEventListener("resize", cb);
  }
  window.addEventListener("resize", cb);
  return () => window.removeEventListener("resize", cb);
}

function getViewportHeightSnapshot(): number {
  return window.visualViewport?.height ?? window.innerHeight;
}

function getViewportHeightServerSnapshot(): number {
  return 800;
}

/**
 * Reactive visual viewport height in pixels.
 * Updates when the virtual keyboard opens/closes (visualViewport.resize)
 * or when the window resizes.
 */
export function useViewportHeight(): number {
  return useSyncExternalStore(
    subscribeViewportHeight,
    getViewportHeightSnapshot,
    getViewportHeightServerSnapshot,
  );
}
