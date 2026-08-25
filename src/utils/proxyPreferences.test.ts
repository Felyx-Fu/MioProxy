import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFavoriteNodes, loadProxyPreferences, PROXY_PREFERENCES_STORAGE_KEY, saveFavoriteNodes, type ProxyPreferenceStorage } from "./proxyPreferences";

function createStorage(): ProxyPreferenceStorage & { clear: () => void } {
  const values = new Map<string, string>();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => { values.set(key, value); },
    clear: () => values.clear(),
  };
}

describe("proxy preference storage", () => {
  let storage: ProxyPreferenceStorage & { clear: () => void };

  beforeEach(() => {
    storage = createStorage();
  });

  afterEach(() => {
    storage.clear();
  });

  it("persists favorite nodes and can reload them", () => {
    saveFavoriteNodes("profile-a", ["HK-1", "HK-1", "SG-2"], storage);

    expect(loadFavoriteNodes("profile-a", storage)).toEqual(["HK-1", "SG-2"]);
    expect(loadProxyPreferences(storage)).toMatchObject({
      version: 1,
      profiles: { "profile-a": { favorites: ["HK-1", "SG-2"] } },
    });
  });

  it("keeps favorites isolated by Profile id", () => {
    saveFavoriteNodes("profile-a", ["HK-1"], storage);
    saveFavoriteNodes("profile-b", ["SG-2"], storage);

    expect(loadFavoriteNodes("profile-a", storage)).toEqual(["HK-1"]);
    expect(loadFavoriteNodes("profile-b", storage)).toEqual(["SG-2"]);
    expect(loadFavoriteNodes("__runtime__", storage)).toEqual([]);
  });

  it("falls back to empty preferences when stored JSON is invalid", () => {
    storage.setItem(PROXY_PREFERENCES_STORAGE_KEY, "{not valid json");

    expect(loadProxyPreferences(storage)).toEqual({ version: 1, profiles: {} });
    expect(loadFavoriteNodes("profile-a", storage)).toEqual([]);
  });

  it("ignores malformed profile entries without exposing them to the UI", () => {
    storage.setItem(PROXY_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      profiles: {
        valid: { favorites: ["HK-1"] },
        malformed: { favorites: "HK-2" },
      },
    }));

    expect(loadFavoriteNodes("valid", storage)).toEqual(["HK-1"]);
    expect(loadFavoriteNodes("malformed", storage)).toEqual([]);
  });
});
