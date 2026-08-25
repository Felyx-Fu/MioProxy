import { NODE_REGION_IDS, type NodeRegion } from "./nodeRegion";

export const PROXY_PREFERENCES_STORAGE_KEY = "mioproxy.proxyPreferences.v1";
export const PROXY_PREFERENCES_VERSION = 1 as const;

export type ProxyProfilePreferences = {
  favorites: string[];
  groupOrder?: string[];
  regionOrder?: ProxyRegionOrderEntry[];
};

export type ProxyPreferences = {
  version: typeof PROXY_PREFERENCES_VERSION;
  profiles: Record<string, ProxyProfilePreferences>;
};

export type ProxyPreferenceStorage = Pick<Storage, "getItem" | "setItem">;
export type ProxyRegionOrderEntry = "favorites" | NodeRegion;

export const DEFAULT_PROXY_REGION_ORDER: readonly ProxyRegionOrderEntry[] = ["favorites", ...NODE_REGION_IDS];
const VALID_REGION_ORDER_ENTRIES = new Set<string>(DEFAULT_PROXY_REGION_ORDER);

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

function uniqueStrings(values: readonly string[]) {
  return [...new Set(values.filter((value) => value.length > 0))];
}

function normalizeOptionalStringArray(value: unknown): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  return uniqueStrings(value.filter((item): item is string => typeof item === "string"));
}

function normalizeRegionOrder(value: unknown): ProxyRegionOrderEntry[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<ProxyRegionOrderEntry>();
  const result: ProxyRegionOrderEntry[] = [];
  for (const item of value) {
    if (typeof item !== "string" || !VALID_REGION_ORDER_ENTRIES.has(item)) continue;
    const entry = item as ProxyRegionOrderEntry;
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}

function normalizePreferences(value: unknown): ProxyPreferences {
  if (!value || typeof value !== "object") return emptyPreferences();
  const candidate = value as { version?: unknown; profiles?: unknown };
  if (candidate.version !== PROXY_PREFERENCES_VERSION || !candidate.profiles || typeof candidate.profiles !== "object" || Array.isArray(candidate.profiles)) {
    return emptyPreferences();
  }

  const profiles: Record<string, ProxyProfilePreferences> = {};
  for (const [scope, profile] of Object.entries(candidate.profiles)) {
    if (!profile || typeof profile !== "object") continue;
    const candidateProfile = profile as { favorites?: unknown; groupOrder?: unknown; regionOrder?: unknown };
    const favorites = isStringArray(candidateProfile.favorites) ? uniqueStrings(candidateProfile.favorites) : [];
    const groupOrder = normalizeOptionalStringArray(candidateProfile.groupOrder);
    const regionOrder = normalizeRegionOrder(candidateProfile.regionOrder);
    const normalizedProfile: ProxyProfilePreferences = { favorites };
    if (groupOrder !== undefined) normalizedProfile.groupOrder = groupOrder;
    if (regionOrder !== undefined) normalizedProfile.regionOrder = regionOrder;
    profiles[scope] = normalizedProfile;
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

export function loadGroupOrder(scope: string, storage: ProxyPreferenceStorage | null = getStorage()): string[] | undefined {
  return loadProxyPreferences(storage).profiles[scope]?.groupOrder?.slice();
}

export function loadRegionOrder(scope: string, storage: ProxyPreferenceStorage | null = getStorage()): ProxyRegionOrderEntry[] | undefined {
  return loadProxyPreferences(storage).profiles[scope]?.regionOrder?.slice();
}

function updateProfilePreferences(scope: string, patch: Partial<ProxyProfilePreferences>, storage: ProxyPreferenceStorage | null) {
  const preferences = loadProxyPreferences(storage);
  const existing = preferences.profiles[scope] ?? { favorites: [] };
  const nextProfile: ProxyProfilePreferences = { ...existing, ...patch };
  const nextProfiles = { ...preferences.profiles };
  if (!nextProfile.favorites.length && !nextProfile.groupOrder?.length && !nextProfile.regionOrder?.length) delete nextProfiles[scope];
  else nextProfiles[scope] = nextProfile;
  saveProxyPreferences({ ...preferences, profiles: nextProfiles }, storage);
}

export function saveFavoriteNodes(scope: string, favorites: Iterable<string>, storage: ProxyPreferenceStorage | null = getStorage()) {
  const nextFavorites = [...new Set([...favorites].filter((node) => typeof node === "string"))];
  updateProfilePreferences(scope, { favorites: nextFavorites }, storage);
}

export function saveGroupOrder(scope: string, groupOrder: readonly string[] | undefined, storage: ProxyPreferenceStorage | null = getStorage()) {
  updateProfilePreferences(scope, { groupOrder: groupOrder === undefined ? undefined : uniqueStrings(groupOrder) }, storage);
}

export function saveRegionOrder(scope: string, regionOrder: readonly ProxyRegionOrderEntry[] | undefined, storage: ProxyPreferenceStorage | null = getStorage()) {
  updateProfilePreferences(scope, { regionOrder: regionOrder === undefined ? undefined : normalizeRegionOrder(regionOrder) }, storage);
}

export function mergeGroupDisplayOrder(
  savedOrder: readonly string[] | undefined,
  backendOrder: readonly string[],
  liveGroupNames: readonly string[],
) {
  const liveNames = uniqueStrings(liveGroupNames);
  const liveSet = new Set(liveNames);
  const backendEffective: string[] = [];
  const backendSeen = new Set<string>();
  for (const name of [...backendOrder, ...liveNames]) {
    if (!liveSet.has(name) || backendSeen.has(name)) continue;
    backendSeen.add(name);
    backendEffective.push(name);
  }

  if (savedOrder === undefined) return backendEffective;
  const result: string[] = [];
  const seen = new Set<string>();
  for (const name of savedOrder) {
    if (!liveSet.has(name) || seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  for (const name of backendEffective) {
    if (seen.has(name)) continue;
    seen.add(name);
    result.push(name);
  }
  return result;
}

export function mergeRegionDisplayOrder(savedOrder: readonly string[] | undefined): ProxyRegionOrderEntry[] {
  const saved = normalizeRegionOrder(savedOrder);
  const result: ProxyRegionOrderEntry[] = [];
  const seen = new Set<ProxyRegionOrderEntry>();
  for (const entry of [...(saved ?? []), ...DEFAULT_PROXY_REGION_ORDER]) {
    if (seen.has(entry)) continue;
    seen.add(entry);
    result.push(entry);
  }
  return result;
}
