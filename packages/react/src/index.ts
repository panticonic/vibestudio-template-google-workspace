/**
 * @workspace/react
 *
 * React bindings for Vibestudio panels. This provides:
 * - React hooks for panel state and RPC
 * - Auto-mount utilities for React panels
 * - React panel mounting helpers
 *
 * Use alongside @workspace/runtime for full functionality.
 */

// Export React-specific functionality only
export * from "./hooks.js";
export { usePanelTheme, usePanelThemeConfig } from "./theme.js";
export { autoMountReactPanel, shouldAutoMount } from "./autoMount.js";
export {
  createReactPanelMount,
  type ReactPanelOptions,
  type ReactPanelInstance,
} from "./reactPanel.js";

// Form rendering components
export {
  FormRenderer,
  formatSliderValue,
  type FormRendererProps,
  type CustomFieldRendererProps,
} from "./FormRenderer.js";

// Responsive hooks
export {
  getVibestudioHostPlatform,
  resolveVibestudioHostPlatform,
  useIsMobile,
  useTouchDevice,
  useViewportHeight,
  type VibestudioHostPlatform,
} from "./responsive.js";
