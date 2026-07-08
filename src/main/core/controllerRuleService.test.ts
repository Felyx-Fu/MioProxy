import { describe, expect, it, vi } from "vitest";
import type { ControllerClient, ControllerClientResult } from "@mioproxy/core-runtime";
import { createControllerRuleService } from "./controllerRuleService.js";

describe("createControllerRuleService", () => {
  it("summarizes rules and rule providers", async () => {
    const service = createControllerRuleService({
      clientFactory: () =>
        fakeClient({
          rules: ok(
            JSON.stringify({
              rules: [
                { type: "DOMAIN-SUFFIX", payload: "example.test", proxy: "DIRECT", size: 1 },
                { type: "RULE-SET", payload: "streaming", proxy: "Proxy" }
              ]
            })
          ),
          providers: ok(
            JSON.stringify({
              providers: {
                streaming: {
                  type: "http",
                  behavior: "classical",
                  vehicleType: "HTTP",
                  ruleCount: 128,
                  updatedAt: "2026-07-07T10:00:00.000Z"
                }
              }
            })
          )
        }),
      now: () => new Date("2026-07-07T10:05:00.000Z")
    });

    const result = await service.snapshot({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      ruleLimit: 1
    });

    expect(result).toEqual({
      ok: true,
      checkedAt: "2026-07-07T10:05:00.000Z",
      rulesStatus: 200,
      providersStatus: 200,
      rules: {
        total: 2,
        items: [{ type: "DOMAIN-SUFFIX", payload: "example.test", proxy: "DIRECT", size: 1 }]
      },
      providers: {
        total: 1,
        items: [
          {
            name: "streaming",
            type: "http",
            behavior: "classical",
            vehicleType: "HTTP",
            ruleCount: 128,
            updatedAt: "2026-07-07T10:00:00.000Z"
          }
        ]
      }
    });
  });

  it("returns controller failures as safe responses", async () => {
    const service = createControllerRuleService({
      clientFactory: () =>
        fakeClient({
          rules: ok(JSON.stringify({ rules: [] })),
          providers: fail("Mihomo controller request failed with HTTP 401", 401)
        })
    });

    const result = await service.snapshot({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: "Mihomo controller request failed with HTTP 401" },
      rulesStatus: 200,
      providersStatus: 401
    });
  });

  it("returns JSON parse failures without throwing", async () => {
    const service = createControllerRuleService({
      clientFactory: () =>
        fakeClient({
          rules: ok("not-json"),
          providers: ok(JSON.stringify({ providers: {} }))
        })
    });

    const result = await service.snapshot({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("Unexpected token");
    }
  });
});

function fakeClient(results: {
  rules: ControllerClientResult;
  providers: ControllerClientResult;
}): ControllerClient {
  return {
    getVersion: vi.fn(async () => ok("")),
    getConfigs: vi.fn(async () => ok("")),
    getTraffic: vi.fn(async () => ok("")),
    getConnections: vi.fn(async () => ok("")),
    getProxies: vi.fn(async () => ok("")),
    getRules: vi.fn(async () => results.rules),
    getRuleProviders: vi.fn(async () => results.providers),
    switchProxy: vi.fn(async () => ok("")),
    testProxyDelay: vi.fn(async () => ok("")),
    reloadConfig: vi.fn(async () => ok("")),
    restart: vi.fn(async () => ok(""))
  };
}

function ok(body: string): ControllerClientResult {
  return { ok: true, status: 200, body };
}

function fail(message: string, status: number): ControllerClientResult {
  return {
    ok: false,
    status,
    body: "",
    timedOut: false,
    error: new Error(message)
  };
}
