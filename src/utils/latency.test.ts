import { describe, expect, it } from "vitest";
import type { ProxyGroup } from "../api/mihomo";
import {
  DEFAULT_DELAY_TEST_URL,
  createProxyDelayContext,
  currentNodeDelayContext,
  effectiveDelayTestUrl,
  providerNameForEntry,
  proxyDelayKey,
  proxyEntryKind,
} from "./latency";

describe("proxy latency context", () => {
  it("uses the active group URL and the HTTPS fallback without user settings", () => {
    expect(effectiveDelayTestUrl(undefined)).toBe(DEFAULT_DELAY_TEST_URL);
    expect(effectiveDelayTestUrl("  ")).toBe(DEFAULT_DELAY_TEST_URL);
    expect(effectiveDelayTestUrl(" https://group.example.test/204 ")).toBe("https://group.example.test/204");

    const context = createProxyDelayContext(
      "ACTIVE",
      { type: "URLTest", testUrl: "https://group.example.test/204", expectedStatus: "204" },
      "same node",
      { type: "Vmess", "provider-name": "provider-a" },
    );
    expect(context).toMatchObject({
      group: "ACTIVE",
      proxy: "same node",
      provider: "provider-a",
      testUrl: "https://group.example.test/204",
      expectedStatus: "204",
      kind: "provider",
    });
  });

  it("uses the active group's URL for the automatic current-node test", () => {
    const proxies = {
      proxies: {
        ACTIVE: { type: "URLTest", now: "same node", all: ["same node"], testUrl: "https://active.example.test/204" },
        OTHER: { type: "Selector", now: "same node", all: ["same node"], testUrl: "https://other.example.test/204" },
        "same node": { type: "Vmess", "provider-name": "provider-a" },
      },
    };

    expect(currentNodeDelayContext(proxies, "ACTIVE", "same node")).toMatchObject({
      group: "ACTIVE",
      proxy: "same node",
      provider: "provider-a",
      testUrl: "https://active.example.test/204",
    });
  });

  it("resolves provider identity from explicit Mihomo metadata, not the node name", () => {
    expect(providerNameForEntry({ type: "Vmess", "provider-name": "provider-a" })).toBe("provider-a");
    expect(providerNameForEntry({ type: "Vmess", providerName: "provider-b" })).toBe("provider-b");
    expect(providerNameForEntry({ type: "Vmess" })).toBeUndefined();
    expect(proxyEntryKind({ type: "Selector", "provider-name": "stale" })).toBe("group");
    expect(proxyEntryKind({ type: "Direct" })).toBe("builtin");
    expect(proxyEntryKind({ type: "Vmess", name: "provider-a" } as ProxyGroup)).toBe("ordinary");
  });

  it("uses backend group-scoped provider metadata when provider-name is empty", () => {
    const context = createProxyDelayContext(
      "PROXY",
      {
        type: "Selector",
        all: ["HK-1"],
        memberContexts: {
          "HK-1": {
            kind: "provider",
            provider: "PROXY",
            providerResolution: "resolved",
          },
        },
      },
      "HK-1",
      { type: "Vless", "provider-name": "" },
    );

    expect(context).toMatchObject({
      group: "PROXY",
      proxy: "HK-1",
      provider: "PROXY",
      kind: "provider",
    });
  });

  it("does not fabricate a provider for an ambiguous backend resolution", () => {
    const context = createProxyDelayContext(
      "AUTO",
      {
        type: "Selector",
        memberContexts: {
          "same node": {
            kind: "ordinary",
            providerCandidates: ["provider-a", "provider-b"],
            providerResolution: "ambiguous",
          },
        },
      },
      "same node",
      { type: "Vmess", "provider-name": "" },
    );

    expect(context).toMatchObject({
      kind: "ordinary",
    });
    expect(context.provider).toBeUndefined();
  });

  it("does not reuse latency for the same node across groups, providers, or URLs", () => {
    const first = createProxyDelayContext(
      "GROUP-A",
      { type: "URLTest", testUrl: "https://a.example.test/204" },
      "same node",
      { type: "Vmess", "provider-name": "provider-a" },
    );
    const otherGroup = { ...first, group: "GROUP-B" };
    const otherProvider = { ...first, provider: "provider-b" };
    const otherUrl = { ...first, testUrl: "https://b.example.test/204" };

    expect(new Set([proxyDelayKey(first), proxyDelayKey(otherGroup), proxyDelayKey(otherProvider), proxyDelayKey(otherUrl)]).size).toBe(4);
  });
});
