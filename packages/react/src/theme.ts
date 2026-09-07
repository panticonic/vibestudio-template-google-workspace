/** Focused React bindings for panel appearance and theme configuration. */
import { useEffect, useState } from "react";
import { panel } from "@workspace/runtime";
import type { ThemeAppearance, ThemeConfig } from "@workspace/runtime";

/** Get the current panel appearance and subscribe to live changes. */
export function usePanelTheme(): ThemeAppearance {
  const [theme, setTheme] = useState<ThemeAppearance>(() => panel.getTheme());

  useEffect(() => panel.onThemeChange(setTheme), []);
  return theme;
}

/** Get the app-wide theme identity and subscribe to live changes. */
export function usePanelThemeConfig(): ThemeConfig {
  const [config, setConfig] = useState<ThemeConfig>(() => panel.getThemeConfig());

  useEffect(() => panel.onThemeConfigChange(setConfig), []);
  return config;
}
