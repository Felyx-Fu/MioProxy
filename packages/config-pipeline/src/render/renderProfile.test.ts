import { describe, expect, it, vi } from "vitest";
import { renderProfile } from "./renderProfile.js";
import type { SubscriptionCache } from "../subscription/downloader.js";

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

describe("renderProfile", () => {
  it("renders raw subscription through yaml overrides, js overrides, and sanitize", async () => {
    const cache = memoryCache();
    const fetcher = vi.fn(async () =>
      response(`
global-client-fingerprint: chrome
rules:
  - MATCH,PROXY
proxy-groups:
  - name: Smart Group
    type: smart
    proxies:
      - A
      - B
`)
    ) as unknown as typeof fetch;

    const result = await renderProfile({
      profileId: "default",
      subscription: {
        url: "https://example.test/sub.yaml",
        cache,
        fetcher,
        sleep: async () => undefined
      },
      yamlOverrides: [
        {
          id: "prepend-example",
          value: { "+rules": ["DOMAIN,example.com,DIRECT"] }
        }
      ],
      jsOverrides: [
        {
          id: "append-final",
          script: `
            function main(config) {
              config.rules.push("FINAL,DIRECT");
              return config;
            }
          `
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rawSource).toBe("network");
      expect(result.config["global-client-fingerprint"]).toBeUndefined();
      expect(result.config.rules).toEqual([
        "DOMAIN,example.com,DIRECT",
        "MATCH,PROXY",
        "FINAL,DIRECT"
      ]);
      expect(result.config["proxy-groups"]?.[0]?.type).toBe("url-test");
      expect(result.renderedYaml).toContain("proxy-groups:");
      expect(result.warnings.map((warning) => warning.code)).toContain("compat.smart-downgrade");
    }
  });

  it("uses stale cached raw yaml when network fails", async () => {
    const cache = memoryCache("mixed-port: 7890\nrules:\n  - MATCH,DIRECT\n");
    const fetcher = vi.fn(async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;

    const result = await renderProfile({
      profileId: "default",
      subscription: {
        url: "https://example.test/sub.yaml",
        retries: 1,
        cache,
        fetcher,
        sleep: async () => undefined
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rawSource).toBe("cache");
      expect(result.config.rules).toEqual(["MATCH,DIRECT"]);
    }
  });

  it("applies mixed overrides in the provided order", async () => {
    const result = await renderProfile({
      profileId: "default",
      subscription: {
        url: "https://example.test/sub.yaml",
        cache: memoryCache(),
        fetcher: vi.fn(async () => response("rules:\n  - MATCH,DIRECT\n")) as unknown as typeof fetch,
        sleep: async () => undefined
      },
      overrides: [
        {
          kind: "js",
          id: "prepend-js",
          script: `
            function main(config) {
              config.rules.unshift("DOMAIN,js-first.test,DIRECT");
              return config;
            }
          `
        },
        {
          kind: "yaml",
          id: "prepend-yaml",
          value: { "+rules": ["DOMAIN,yaml-second.test,DIRECT"] }
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.rules).toEqual([
        "DOMAIN,yaml-second.test,DIRECT",
        "DOMAIN,js-first.test,DIRECT",
        "MATCH,DIRECT"
      ]);
    }
  });

  it("applies final yaml overrides after mixed overrides", async () => {
    const result = await renderProfile({
      profileId: "default",
      subscription: {
        url: "https://example.test/sub.yaml",
        cache: memoryCache(),
        fetcher: vi.fn(async () => response("secret: from-sub\nrules:\n  - MATCH,DIRECT\n")) as unknown as typeof fetch,
        sleep: async () => undefined
      },
      overrides: [
        {
          kind: "js",
          id: "script-secret",
          script: `
            function main(config) {
              config.secret = "from-script";
              return config;
            }
          `
        }
      ],
      finalYamlOverrides: [
        {
          id: "runtime-controller",
          value: { secret: "runtime-secret" }
        }
      ]
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.config.secret).toBe("runtime-secret");
    }
  });

  it("returns parse stage failures", async () => {
    const result = await renderProfile({
      profileId: "default",
      subscription: {
        url: "https://example.test/sub.yaml",
        cache: memoryCache(),
        fetcher: vi.fn(async () => response("- invalid\n- root\n")) as unknown as typeof fetch,
        sleep: async () => undefined
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("parse");
    }
  });

  it("returns yaml override id on yaml override failures", async () => {
    const result = await renderProfile({
      profileId: "default",
      subscription: {
        url: "https://example.test/sub.yaml",
        cache: memoryCache(),
        fetcher: vi.fn(async () => response("rules:\n  - MATCH,DIRECT\n")) as unknown as typeof fetch,
        sleep: async () => undefined
      },
      yamlOverrides: [{ id: "bad-rules", value: { "+rules": "DOMAIN,example.com,DIRECT" } }]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("yaml-override");
      expect(result.overrideId).toBe("bad-rules");
    }
  });

  it("returns js override id on js override failures", async () => {
    const result = await renderProfile({
      profileId: "default",
      subscription: {
        url: "https://example.test/sub.yaml",
        cache: memoryCache(),
        fetcher: vi.fn(async () => response("rules:\n  - MATCH,DIRECT\n")) as unknown as typeof fetch,
        sleep: async () => undefined
      },
      jsOverrides: [
        {
          id: "bad-script",
          script: `
            function main(config) {
              return null;
            }
          `
        }
      ]
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("js-override");
      expect(result.overrideId).toBe("bad-script");
    }
  });
});
