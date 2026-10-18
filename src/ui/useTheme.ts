// Light, dark, or whatever the system says. The choice persists; "system" follows the OS live.
import { useCallback, useEffect, useState } from "react";
import { z } from "zod";
import type { Theme } from "../canvas/BoardCanvas";
import { useMediaQuery } from "./useMediaQuery";

export const ThemePreference = z.enum(["system", "light", "dark"]);
export type ThemePreference = z.infer<typeof ThemePreference>;

const KEY = "rtw-theme";

function readPreference(): ThemePreference {
  try {
    const parsed = ThemePreference.safeParse(window.localStorage.getItem(KEY));
    return parsed.success ? parsed.data : "system";
  } catch {
    return "system";
  }
}

/** A theme flip touches every surface at once; with transitions on it smears instead of snapping. */
function withoutTransitions(apply: () => void) {
  const style = document.createElement("style");
  style.textContent = "*,*::before,*::after{transition:none !important}";
  document.head.appendChild(style);
  apply();
  void document.body.offsetHeight;
  requestAnimationFrame(() => style.remove());
}

export function useTheme(): { theme: Theme; preference: ThemePreference; setPreference: (next: ThemePreference) => void; toggle: () => void } {
  const [preference, setPreferenceState] = useState<ThemePreference>(readPreference);
  const systemDark = useMediaQuery("(prefers-color-scheme: dark)");
  const theme: Theme = preference === "system" ? (systemDark ? "dark" : "light") : preference;

  useEffect(() => {
    const root = document.documentElement;
    if (root.dataset.theme === theme) return;
    withoutTransitions(() => {
      root.dataset.theme = theme;
    });
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme === "dark" ? "#0b0c0d" : "#f9f9fa");
  }, [theme]);

  const setPreference = useCallback((next: ThemePreference) => {
    setPreferenceState(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // Private mode: the choice lasts for this visit only.
    }
  }, []);

  const toggle = useCallback(() => setPreference(theme === "dark" ? "light" : "dark"), [setPreference, theme]);
  return { theme, preference, setPreference, toggle };
}
