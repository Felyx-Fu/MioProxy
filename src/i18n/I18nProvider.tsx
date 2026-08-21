import { createContext, ReactNode, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { enUS, type MessageKey } from "../locales/en-US";
import { zhCN } from "../locales/zh-CN";

export type Locale = "zh-CN" | "en-US";
export type LanguagePreference = "system" | Locale;
export type TranslationValues = Record<string, string | number>;

const LANGUAGE_STORAGE_KEY = "mioproxy.ui.language:v1";

type I18nContextValue = {
  locale: Locale;
  languagePreference: LanguagePreference;
  setLanguagePreference: (preference: LanguagePreference) => void;
  t: (key: MessageKey, values?: TranslationValues) => string;
};

const I18nContext = createContext<I18nContextValue | null>(null);
const catalogs: Record<Locale, Record<MessageKey, string>> = {
  "en-US": enUS,
  "zh-CN": zhCN,
};

export function normalizeLocale(value: string | null | undefined): Locale {
  return value && /^zh(?:-|$)/i.test(value) ? "zh-CN" : "en-US";
}

function systemLocale(): Locale {
  if (typeof navigator === "undefined") return "en-US";
  return normalizeLocale(navigator.languages?.[0] ?? navigator.language);
}

function readLanguagePreference(): LanguagePreference {
  if (typeof window === "undefined") return "system";
  try {
    const saved = window.localStorage.getItem(LANGUAGE_STORAGE_KEY);
    return saved === "zh-CN" || saved === "en-US" || saved === "system" ? saved : "system";
  } catch {
    return "system";
  }
}

function saveLanguagePreference(preference: LanguagePreference) {
  try {
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, preference);
  } catch {
    // The in-memory preference remains valid when WebView storage is unavailable.
  }
}

function interpolate(message: string, values?: TranslationValues) {
  if (!values) return message;
  return message.replace(/\{([a-zA-Z0-9_]+)\}/g, (placeholder, key: string) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key]) : placeholder,
  );
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [languagePreference, setPreference] = useState<LanguagePreference>(readLanguagePreference);
  const [detectedLocale, setDetectedLocale] = useState<Locale>(systemLocale);
  const locale = languagePreference === "system" ? detectedLocale : languagePreference;

  useEffect(() => {
    const handleLanguageChange = () => setDetectedLocale(systemLocale());
    window.addEventListener("languagechange", handleLanguageChange);
    return () => window.removeEventListener("languagechange", handleLanguageChange);
  }, []);

  useLayoutEffect(() => {
    document.documentElement.lang = locale;
    document.documentElement.dataset.locale = locale;
    document.documentElement.dataset.languagePreference = languagePreference;
  }, [languagePreference, locale]);

  const setLanguagePreference = useCallback((preference: LanguagePreference) => {
    setPreference(preference);
    saveLanguagePreference(preference);
  }, []);

  const t = useCallback((key: MessageKey, values?: TranslationValues) =>
    interpolate(catalogs[locale][key] ?? enUS[key], values), [locale]);

  const value = useMemo<I18nContextValue>(() => ({
    locale,
    languagePreference,
    setLanguagePreference,
    t,
  }), [languagePreference, locale, setLanguagePreference, t]);

  return <I18nContext.Provider value={value}>{children}</I18nContext.Provider>;
}

export function useI18n() {
  const value = useContext(I18nContext);
  if (!value) throw new Error("useI18n must be used within I18nProvider");
  return value;
}
