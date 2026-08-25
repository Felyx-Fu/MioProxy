import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadFavoriteNodes, loadGroupOrder, loadProxyPreferences, loadRegionOrder, mergeGroupDisplayOrder, mergeRegionDisplayOrder, PROXY_PREFERENCES_STORAGE_KEY, saveFavoriteNodes, saveGroupOrder, saveRegionOrder, type ProxyPreferenceStorage } from "./proxyPreferences";

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

  it("extends a favorites-only profile without destroying existing metadata", () => {
    saveFavoriteNodes("profile-a", ["HK-1"], storage);
    saveGroupOrder("profile-a", ["GLOBAL", "PROXY", "PROXY"], storage);
    saveRegionOrder("profile-a", ["favorites", "sg", "hk"], storage);

    expect(loadFavoriteNodes("profile-a", storage)).toEqual(["HK-1"]);
    expect(loadGroupOrder("profile-a", storage)).toEqual(["GLOBAL", "PROXY"]);
    expect(loadRegionOrder("profile-a", storage)).toEqual(["favorites", "sg", "hk"]);
  });

  it("keeps favorites and display orders isolated between profiles", () => {
    saveFavoriteNodes("profile-a", ["A"], storage);
    saveGroupOrder("profile-a", ["Group A"], storage);
    saveRegionOrder("profile-a", ["favorites", "hk"], storage);
    saveFavoriteNodes("profile-b", ["B"], storage);
    saveGroupOrder("profile-b", ["Group B"], storage);
    saveRegionOrder("profile-b", ["favorites", "sg"], storage);

    expect(loadFavoriteNodes("profile-a", storage)).toEqual(["A"]);
    expect(loadGroupOrder("profile-a", storage)).toEqual(["Group A"]);
    expect(loadRegionOrder("profile-a", storage)).toEqual(["favorites", "hk"]);
    expect(loadFavoriteNodes("profile-b", storage)).toEqual(["B"]);
    expect(loadGroupOrder("profile-b", storage)).toEqual(["Group B"]);
    expect(loadRegionOrder("profile-b", storage)).toEqual(["favorites", "sg"]);
  });

  it("reconciles stale and duplicate group order entries with live backend order", () => {
    expect(mergeGroupDisplayOrder(["PROXY", "GLOBAL", "PROXY", "stale"], ["PROXY", "JP Auto", "GLOBAL"], ["PROXY", "JP Auto", "GLOBAL"])).toEqual(["PROXY", "GLOBAL", "JP Auto"]);
    expect(mergeGroupDisplayOrder(undefined, ["PROXY", "GLOBAL"], ["PROXY", "GLOBAL", "Auto"])).toEqual(["PROXY", "GLOBAL", "Auto"]);
  });

  it("reconciles region order by identity and appends newly supported regions canonically", () => {
    const merged = mergeRegionDisplayOrder(["sg", "sg", "invalid", "unknown", "all"]);
    expect(merged.slice(0, 4)).toEqual(["sg", "unknown", "favorites", "hk"]);
    expect(merged).toContain("id");
    expect(merged).toContain("favorites");
  });

  it("normalizes malformed persisted ordering without dropping valid favorites", () => {
    storage.setItem(PROXY_PREFERENCES_STORAGE_KEY, JSON.stringify({
      version: 1,
      profiles: {
        "profile-a": {
          favorites: ["HK-1"],
          groupOrder: ["PROXY", "PROXY", 12, ""],
          regionOrder: ["sg", "invalid", "sg", "all"],
        },
      },
    }));

    expect(loadFavoriteNodes("profile-a", storage)).toEqual(["HK-1"]);
    expect(loadGroupOrder("profile-a", storage)).toEqual(["PROXY"]);
    expect(loadRegionOrder("profile-a", storage)).toEqual(["sg"]);
  });
});
