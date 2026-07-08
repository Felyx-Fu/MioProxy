import { describe, expect, it, vi } from "vitest";
import { downloadSubscription, type SubscriptionCache } from "./downloader.js";

function memoryCache(initial?: string): SubscriptionCache & { written: string[] } {
  const state = { value: initial ?? null, written: [] as string[] };
  return {
    written: state.written,
    async read() {
      return state.value;
    },
    async write(_profileId, contents) {
      state.value = contents;
      state.written.push(contents);
    }
  };
}

function response(body: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => body
  } as Response;
}

describe("downloadSubscription", () => {
  it("downloads and caches non-empty subscriptions", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn(async () => response("mixed-port: 7890\n")) as unknown as typeof fetch;

    const result = await downloadSubscription({
      profileId: "default",
      url: "https://example.test/sub.yaml",
      cache,
      fetcher,
      sleep: async () => undefined
    });

    expect(result).toEqual({
      ok: true,
      source: "network",
      contents: "mixed-port: 7890\n",
      attempts: 1
    });
    expect(cache.written).toEqual(["mixed-port: 7890\n"]);
  });

  it("uses stale cache when the network fails", async () => {
    const cache = memoryCache("mixed-port: 7890\n");
    const fetcher = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await downloadSubscription({
      profileId: "default",
      url: "https://example.test/sub.yaml",
      retries: 2,
      cache,
      fetcher,
      sleep: async () => undefined
    });

    expect(result).toEqual({
      ok: true,
      source: "cache",
      contents: "mixed-port: 7890\n",
      attempts: 2
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("rejects empty network responses and keeps the old cache", async () => {
    const cache = memoryCache("mixed-port: 7890\n");
    const fetcher = vi.fn(async () => response("\n")) as unknown as typeof fetch;

    const result = await downloadSubscription({
      profileId: "default",
      url: "https://example.test/sub.yaml",
      retries: 1,
      cache,
      fetcher,
      sleep: async () => undefined
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.source).toBe("cache");
      expect(result.contents).toBe("mixed-port: 7890\n");
    }
    expect(cache.written).toEqual([]);
  });

  it("returns failure when network and cache are both unavailable", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn(async () => response("not found", { ok: false, status: 404 })) as unknown as typeof fetch;

    const result = await downloadSubscription({
      profileId: "default",
      url: "https://example.test/sub.yaml",
      retries: 1,
      cache,
      fetcher,
      sleep: async () => undefined
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("HTTP 404");
    }
  });
});
