import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow, type Theme } from "@tauri-apps/api/window";
import { createContext, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";

export type ThemePreference = "system" | "light" | "dark";
export type ResolvedTheme = "light" | "dark";

export type WindowMaterialStatus = {
  supported: boolean;
  systemTransparencyEnabled: boolean;
  applied: boolean;
  fallbackReason: string | null;
};

type AppearanceContextValue = {
  themePreference: ThemePreference;
  resolvedTheme: ResolvedTheme;
  setThemePreference: (preference: ThemePreference) => void;
  useWindowsMaterial: boolean;
  setUseWindowsMaterial: (enabled: boolean) => void;
  materialStatus: WindowMaterialStatus;
};

declare global {
  interface Window {
    __TAURI_INTERNALS__?: unknown;
    __MIOPROXY_VISUAL_PREVIEW__?: boolean;
  }
}

const THEME_STORAGE_KEY = "mioproxy.ui.theme:v1";
const MATERIAL_STORAGE_KEY = "mioproxy.ui.windows-material:v1";

const solidFallback: WindowMaterialStatus = {
  supported: false,
  systemTransparencyEnabled: false,
  applied: false,
  fallbackReason: "not-applied",
};

const AppearanceContext = createContext<AppearanceContextValue | null>(null);

export function isNativeRuntime() {
  return typeof window !== "undefined"
    && Boolean(window.__TAURI_INTERNALS__)
    && !window.__MIOPROXY_VISUAL_PREVIEW__;
}

function readThemePreference(): ThemePreference {
  if (typeof window === "undefined") return "system";
  try {
    const saved = window.localStorage.getItem(THEME_STORAGE_KEY);
    return saved === "light" || saved === "dark" || saved === "system" ? saved : "system";
  } catch {
    return "system";
  }
}

function readMaterialPreference() {
  if (typeof window === "undefined") return true;
  try {
    return window.localStorage.getItem(MATERIAL_STORAGE_KEY) !== "off";
  } catch {
    return true;
  }
}

function browserSystemTheme(): ResolvedTheme {
  return typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches
    ? "dark"
    : "light";
}

function savePreference(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // The current session continues with the in-memory value.
  }
}

export function bootstrapAppearance() {
  const themePreference = readThemePreference();
  const resolvedTheme = themePreference === "system" ? browserSystemTheme() : themePreference;
  const materialPreference = readMaterialPreference();
  const root = document.documentElement;
  root.dataset.theme = resolvedTheme;
  root.dataset.themePreference = themePreference;
  root.dataset.materialPreference = materialPreference ? "on" : "off";
  root.dataset.material = "solid";
  root.style.colorScheme = resolvedTheme;
}

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [themePreference, setStoredThemePreference] = useState<ThemePreference>(readThemePreference);
  const [systemTheme, setSystemTheme] = useState<ResolvedTheme>(browserSystemTheme);
  const [useWindowsMaterial, setStoredWindowsMaterial] = useState(readMaterialPreference);
  const [materialStatus, setMaterialStatus] = useState<WindowMaterialStatus>(solidFallback);
  const resolvedTheme = themePreference === "system" ? systemTheme : themePreference;

  useEffect(() => {
    if (!isNativeRuntime()) {
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      const onChange = (event: MediaQueryListEvent) => setSystemTheme(event.matches ? "dark" : "light");
      setSystemTheme(media.matches ? "dark" : "light");
      media.addEventListener("change", onChange);
      return () => media.removeEventListener("change", onChange);
    }

    let active = true;
    let unlisten: (() => void) | undefined;
    const appWindow = getCurrentWindow();
    void appWindow.theme().then((theme) => {
      if (active && theme) setSystemTheme(theme);
    }).catch(() => undefined);
    void appWindow.onThemeChanged(({ payload }) => {
      if (active) setSystemTheme(payload);
    }).then((stop) => {
      if (active) unlisten = stop;
      else stop();
    }).catch(() => undefined);
    return () => {
      active = false;
      unlisten?.();
    };
  }, []);

  useEffect(() => {
    if (!isNativeRuntime()) {
      setMaterialStatus({ ...solidFallback, fallbackReason: "browser-preview" });
      return;
    }

    let active = true;
    const appWindow = getCurrentWindow();
    void (async () => {
      try {
        await appWindow.setTheme(themePreference === "system" ? null : themePreference as Theme);
        const status = await invoke<WindowMaterialStatus>("window_material_set", {
          enabled: useWindowsMaterial,
          theme: themePreference,
        });
        if (active) setMaterialStatus(status);
      } catch (error) {
        if (active) {
          setMaterialStatus({
            ...solidFallback,
            fallbackReason: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })();
    return () => {
      active = false;
    };
  }, [themePreference, useWindowsMaterial]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.theme = resolvedTheme;
    root.dataset.themePreference = themePreference;
    root.dataset.materialPreference = useWindowsMaterial ? "on" : "off";
    root.dataset.material = materialStatus.applied ? "mica" : "solid";
    root.style.colorScheme = resolvedTheme;
  }, [materialStatus.applied, resolvedTheme, themePreference, useWindowsMaterial]);

  const setThemePreference = useCallback((preference: ThemePreference) => {
    setStoredThemePreference(preference);
    savePreference(THEME_STORAGE_KEY, preference);
  }, []);

  const setUseWindowsMaterial = useCallback((enabled: boolean) => {
    setStoredWindowsMaterial(enabled);
    savePreference(MATERIAL_STORAGE_KEY, enabled ? "on" : "off");
  }, []);

  const value = useMemo<AppearanceContextValue>(() => ({
    themePreference,
    resolvedTheme,
    setThemePreference,
    useWindowsMaterial,
    setUseWindowsMaterial,
    materialStatus,
  }), [materialStatus, resolvedTheme, setThemePreference, setUseWindowsMaterial, themePreference, useWindowsMaterial]);

  return <AppearanceContext.Provider value={value}>{children}</AppearanceContext.Provider>;
}

export function useAppearance() {
  const value = useContext(AppearanceContext);
  if (!value) throw new Error("useAppearance must be used within AppearanceProvider");
  return value;
}
