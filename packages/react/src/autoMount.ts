/**
 * Auto-mounting system for React panels with zero configuration.
 * This module automatically mounts default exports or named App exports.
 */

import type { ComponentType } from "react";
import React from "react";
import { createRoot } from "react-dom/client";
import { Theme } from "@radix-ui/themes";
import { createReactPanelMount } from "./reactPanel.js";
import { usePanelThemeConfig } from "./theme.js";

export interface AutoMountConfig {
  rootId?: string;
  enableTheme?: boolean;
}

/**
 * Auto-mount a React component from a module.
 * Looks for default export or named "App" export.
 *
 * @param userModule - The imported user module
 * @param config - Auto-mount configuration
 */
export function autoMountReactPanel(userModule: any, config: AutoMountConfig = {}): void {
  // Try to find the component to mount
  let Component: ComponentType<any>;

  if (userModule.default) {
    Component = userModule.default;
  } else if (userModule.App) {
    Component = userModule.App;
  } else {
    throw new Error(
      "No component found to mount. Export a default component or named 'App' component."
    );
  }

  // Use Radix Theme unless explicitly disabled
  const ThemeComponent =
    config.enableTheme === false
      ? undefined
      : function AppThemeProvider({ appearance, children }: React.ComponentProps<typeof Theme>) {
          return React.createElement(Theme, { appearance, ...usePanelThemeConfig() }, children);
        };

  // Create mount function
  const mount = createReactPanelMount(React, createRoot, {
    rootId: config.rootId,
    ThemeComponent,
  });

  // Mount the component
  mount(Component);
}

/**
 * Detects if a module should be auto-mounted.
 * Returns false if the module manually calls mount().
 */
export function shouldAutoMount(userModule: any): boolean {
  // If module has __noAutoMount, respect it
  if (userModule.__noAutoMount === true) {
    return false;
  }

  // If module has default or App export, auto-mount
  return !!(userModule.default || userModule.App);
}
