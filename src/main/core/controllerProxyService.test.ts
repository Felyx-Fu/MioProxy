import { describe, expect, it, vi } from "vitest";
import type { ControllerClient, ControllerClientResult } from "@mioproxy/core-runtime";
import { createControllerProxyService } from "./controllerProxyService.js";

describe("createControllerProxyService", () => {
  it("summarizes proxy groups from the controller proxies map", async () => {
    const service = createControllerProxyService({
      clientFactory: () =>
        fakeClient(
          ok(
            JSON.stringify({
              proxies: {
                GLOBAL: {
                  type: "Selector",
                  now: "Node A",
                  all: ["Node A", "Node B", "DIRECT"]
                },
                "Auto Test": {
                  type: "URLTest",
                  now: "Node B",
                  all: ["Node B", "Node C"]
                },
                "Node A": {
                  type: "Shadowsocks",
                  history: []
                }
              }
            })
          )
        ),
      now: () => new Date("2026-07-07T10:05:00.000Z")
    });

    const result = await service.snapshot({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      optionLimit: 2
    });

    expect(result).toEqual({
      ok: true,
      checkedAt: "2026-07-07T10:05:00.000Z",
      total: 3,
      proxiesStatus: 200,
      groups: [
        {
          name: "GLOBAL",
          type: "Selector",
          current: "Node A",
          optionCount: 3,
          options: ["Node A", "Node B"]
        },
        {
          name: "Auto Test",
          type: "URLTest",
          current: "Node B",
          optionCount: 2,
          options: ["Node B", "Node C"]
        }
      ]
    });
  });

  it("returns controller failures as safe responses", async () => {
    const service = createControllerProxyService({
      clientFactory: () => fakeClient(fail("Mihomo controller request failed with HTTP 401", 401))
    });

    const result = await service.snapshot({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: "Mihomo controller request failed with HTTP 401" },
      proxiesStatus: 401
    });
  });

  it("reports malformed proxies payloads without throwing", async () => {
    const service = createControllerProxyService({
      clientFactory: () => fakeClient(ok(JSON.stringify({ items: [] })))
    });

    const result = await service.snapshot({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("proxies object");
    }
  });

  it("switches a proxy group and returns a refreshed snapshot", async () => {
    const switchProxy = vi.fn(async () => ok(""));
    const service = createControllerProxyService({
      clientFactory: () =>
        fakeClient(
          ok(
            JSON.stringify({
              proxies: {
                GLOBAL: {
                  type: "Selector",
                  now: "Node B",
                  all: ["Node A", "Node B"]
                }
              }
            })
          ),
          switchProxy
        ),
      now: () => new Date("2026-07-07T10:05:00.000Z")
    });

    const result = await service.switchProxy({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      groupName: " GLOBAL ",
      proxyName: " Node B "
    });

    expect(switchProxy).toHaveBeenCalledWith("GLOBAL", "Node B");
    expect(result).toMatchObject({
      ok: true,
      switchedAt: "2026-07-07T10:05:00.000Z",
      status: 200,
      groupName: "GLOBAL",
      proxyName: "Node B",
      snapshot: {
        ok: true,
        groups: [{ name: "GLOBAL", current: "Node B" }]
      }
    });
  });

  it("returns controller failures when switching a group fails", async () => {
    const service = createControllerProxyService({
      clientFactory: () =>
        fakeClient(
          ok(JSON.stringify({ proxies: {} })),
          vi.fn(async () => fail("Mihomo controller request failed with HTTP 400", 400))
        )
    });

    const result = await service.switchProxy({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      groupName: "GLOBAL",
      proxyName: "Missing"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: "Mihomo controller request failed with HTTP 400" },
      status: 400,
      groupName: "GLOBAL",
      proxyName: "Missing"
    });
  });

  it("validates switch inputs before calling the controller", async () => {
    const switchProxy = vi.fn(async () => ok(""));
    const service = createControllerProxyService({
      clientFactory: () => fakeClient(ok(JSON.stringify({ proxies: {} })), switchProxy)
    });

    const result = await service.switchProxy({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      groupName: " ",
      proxyName: "Node A"
    });

    expect(result.ok).toBe(false);
    expect(switchProxy).not.toHaveBeenCalled();
    if (!result.ok) {
      expect(result.error.message).toBe("groupName is required");
    }
  });

  it("tests proxy delay with a normalized URL and bounded timeout", async () => {
    const testProxyDelay = vi.fn(async () => ok(JSON.stringify({ delay: 123 })));
    const service = createControllerProxyService({
      clientFactory: () =>
        fakeClient(ok(JSON.stringify({ proxies: {} })), vi.fn(async () => ok("")), testProxyDelay),
      now: () => new Date("2026-07-07T10:05:00.000Z")
    });

    const result = await service.testDelay({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      proxyName: " Node A ",
      testUrl: "https://example.test/generate_204",
      timeoutMs: 750
    });

    expect(testProxyDelay).toHaveBeenCalledWith(
      "Node A",
      "https://example.test/generate_204",
      1000
    );
    expect(result).toEqual({
      ok: true,
      checkedAt: "2026-07-07T10:05:00.000Z",
      proxyName: "Node A",
      delayMs: 123,
      status: 200,
      testUrl: "https://example.test/generate_204",
      timeoutMs: 1000
    });
  });

  it("returns controller failures when delay checks fail", async () => {
    const service = createControllerProxyService({
      clientFactory: () =>
        fakeClient(
          ok(JSON.stringify({ proxies: {} })),
          vi.fn(async () => ok("")),
          vi.fn(async () => fail("Mihomo controller request failed with HTTP 504", 504))
        )
    });

    const result = await service.testDelay({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      proxyName: "Node A"
    });

    expect(result).toMatchObject({
      ok: false,
      error: { message: "Mihomo controller request failed with HTTP 504" },
      status: 504,
      proxyName: "Node A"
    });
  });

  it("reports malformed delay payloads without throwing", async () => {
    const service = createControllerProxyService({
      clientFactory: () =>
        fakeClient(
          ok(JSON.stringify({ proxies: {} })),
          vi.fn(async () => ok("")),
          vi.fn(async () => ok(JSON.stringify({ value: 10 })))
        )
    });

    const result = await service.testDelay({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      proxyName: "Node A"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("numeric delay");
    }
  });
});

function fakeClient(
  proxies: ControllerClientResult,
  switchProxy = vi.fn(async () => ok("")),
  testProxyDelay = vi.fn(async () => ok(JSON.stringify({ delay: 1 })))
): ControllerClient {
  return {
    getVersion: vi.fn(async () => ok("")),
    getConfigs: vi.fn(async () => ok("")),
    getTraffic: vi.fn(async () => ok("")),
    getConnections: vi.fn(async () => ok("")),
    getProxies: vi.fn(async () => proxies),
    getRules: vi.fn(async () => ok("")),
    getRuleProviders: vi.fn(async () => ok("")),
    switchProxy,
    testProxyDelay,
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
