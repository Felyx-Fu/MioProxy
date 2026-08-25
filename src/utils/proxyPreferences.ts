export const PROXY_PREFERENCES_STORAGE_KEY = "mioproxy.proxyPreferences.v1";
export const PROXY_PREFERENCES_VERSION = 1 as const;

export type ProxyProfilePreferences = {
  favorites: string[];
};

export type ProxyPreferences = {
  version: typeof PROXY_PREFERENCES_VERSION;
  profiles: Record<string, ProxyProfilePreferences>;
};

export type ProxyPreferenceStorage = Pick<Storage, "getItem" | "setItem">;

function emptyPreferences(): ProxyPreferences {
  return { version: PROXY_PREFERENCES_VERSION, profiles: {} };
}

function getStorage(): ProxyPreferenceStorage | null {
  if (typeof window === "undefined") return null;
  try {
    const storage = window.localStorage;
    return typeof storage.getItem === "function" && typeof storage.setItem === "function" ? storage : null;
  } catch {
    return null;
  }
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function normalizePreferences(value: unknown): ProxyPreferences {
  if (!value || typeof value !== "object") return emptyPreferences();
  const candidate = value as { version?: unknown; profiles?: unknown };
  if (candidate.version !== PROXY_PREFERENCES_VERSION || !candidate.profiles || typeof candidate.profiles !== "object") {
    return emptyPreferences();
  }

  const profiles: Record<string, ProxyProfilePreferences> = {};
  for (const [scope, profile] of Object.entries(candidate.profiles)) {
    if (!profile || typeof profile !== "object") continue;
    const favorites = (profile as { favorites?: unknown }).favorites;
    if (!isStringArray(favorites)) continue;
    profiles[scope] = { favorites: [...new Set(favorites)] };
  }
  return { version: PROXY_PREFERENCES_VERSION, profiles };
}

export function loadProxyPreferences(storage: ProxyPreferenceStorage | null = getStorage()): ProxyPreferences {
  if (!storage) return emptyPreferences();
  try {
    const raw = storage.getItem(PROXY_PREFERENCES_STORAGE_KEY);
    if (!raw) return emptyPreferences();
    return normalizePreferences(JSON.parse(raw) as unknown);
  } catch {
    return emptyPreferences();
  }
}

export function saveProxyPreferences(preferences: ProxyPreferences, storage: ProxyPreferenceStorage | null = getStorage()) {
  if (!storage) return;
  try {
    storage.setItem(PROXY_PREFERENCES_STORAGE_KEY, JSON.stringify(normalizePreferences(preferences)));
  } catch {
    // UI state remains usable when WebView storage is unavailable or full.
  }
}

export function loadFavoriteNodes(scope: string, storage: ProxyPreferenceStorage | null = getStorage()): string[] {
  return loadProxyPreferences(storage).profiles[scope]?.favorites ?? [];
}

export function saveFavoriteNodes(scope: string, favorites: Iterable<string>, storage: ProxyPreferenceStorage | null = getStorage()) {
  const preferences = loadProxyPreferences(storage);
  const nextFavorites = [...new Set([...favorites].filter((node) => typeof node === "string"))];
  const nextProfiles = { ...preferences.profiles };
  if (nextFavorites.length) nextProfiles[scope] = { favorites: nextFavorites };
  else delete nextProfiles[scope];
  saveProxyPreferences({ ...preferences, profiles: nextProfiles }, storage);
}
