import { describe, expect, it, vi } from "vitest";
import { createControllerClient } from "./controllerClient.js";

function response(body: string, init?: { ok?: boolean; status?: number }): Response {
  return {
    ok: init?.ok ?? true,
    status: init?.status ?? 200,
    text: async () => body
  } as Response;
}

describe("createControllerClient", () => {
  it("reads version through GET /version with bearer secret", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (url, init) => {
      calls.push({ url: url as URL, init: init as RequestInit });
      return response(JSON.stringify({ version: "v1.19.1", meta: true }));
    }) as unknown as typeof fetch;
    const client = createControllerClient({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      fetcher
    });

    await expect(client.getVersion()).resolves.toEqual({
      ok: true,
      status: 200,
      body: JSON.stringify({ version: "v1.19.1", meta: true })
    });
    expect(calls[0]?.url.toString()).toBe("http://127.0.0.1:9090/version");
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers).toEqual({
      Authorization: "Bearer secret-value",
      "Content-Type": "application/json"
    });
  });

  it("reads running configs through GET /configs", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (url, init) => {
      calls.push({ url: url as URL, init: init as RequestInit });
      return response(JSON.stringify({ mode: "rule", "mixed-port": 7890 }));
    }) as unknown as typeof fetch;
    const client = createControllerClient({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      fetcher
    });

    await expect(client.getConfigs()).resolves.toEqual({
      ok: true,
      status: 200,
      body: JSON.stringify({ mode: "rule", "mixed-port": 7890 })
    });
    expect(calls[0]?.url.toString()).toBe("http://127.0.0.1:9090/configs");
    expect(calls[0]?.init.method).toBe("GET");
  });

  it("reads observation, proxy, and rule endpoints through authenticated GET requests", async () => {
    const urls: string[] = [];
    const fetcher = vi.fn(async (url) => {
      urls.push((url as URL).toString());
      return response("{}");
    }) as unknown as typeof fetch;
    const client = createControllerClient({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      fetcher
    });

    await expect(client.getTraffic()).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(client.getConnections()).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(client.getProxies()).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(client.getRules()).resolves.toMatchObject({ ok: true, status: 200 });
    await expect(client.getRuleProviders()).resolves.toMatchObject({ ok: true, status: 200 });

    expect(urls).toEqual([
      "http://127.0.0.1:9090/traffic",
      "http://127.0.0.1:9090/connections",
      "http://127.0.0.1:9090/proxies",
      "http://127.0.0.1:9090/rules",
      "http://127.0.0.1:9090/providers/rules"
    ]);
    expect(fetcher).toHaveBeenCalledWith(expect.any(URL), {
      method: "GET",
      headers: {
        Authorization: "Bearer secret-value",
        "Content-Type": "application/json"
      },
      body: undefined,
      signal: expect.any(AbortSignal)
    });
  });

  it("reloads config through PUT /configs?force=true with bearer secret", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (url, init) => {
      calls.push({ url: url as URL, init: init as RequestInit });
      return response("", { status: 204 });
    }) as unknown as typeof fetch;
    const client = createControllerClient({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      fetcher
    });

    await expect(client.reloadConfig("C:\\MioProxy\\active.yaml")).resolves.toEqual({
      ok: true,
      status: 204,
      body: ""
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url.toString()).toBe("http://127.0.0.1:9090/configs?force=true");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.headers).toEqual({
      Authorization: "Bearer secret-value",
      "Content-Type": "application/json"
    });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ path: "C:\\MioProxy\\active.yaml" }));
  });

  it("switches a proxy group through PUT /proxies/{name}", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (url, init) => {
      calls.push({ url: url as URL, init: init as RequestInit });
      return response("", { status: 204 });
    }) as unknown as typeof fetch;
    const client = createControllerClient({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      fetcher
    });

    await expect(client.switchProxy("Auto Test", "Node A")).resolves.toEqual({
      ok: true,
      status: 204,
      body: ""
    });

    expect(calls[0]?.url.toString()).toBe("http://127.0.0.1:9090/proxies/Auto%20Test");
    expect(calls[0]?.init.method).toBe("PUT");
    expect(calls[0]?.init.headers).toEqual({
      Authorization: "Bearer secret-value",
      "Content-Type": "application/json"
    });
    expect(calls[0]?.init.body).toBe(JSON.stringify({ name: "Node A" }));
  });

  it("tests proxy delay through GET /proxies/{name}/delay", async () => {
    const calls: Array<{ url: URL; init: RequestInit }> = [];
    const fetcher = vi.fn(async (url, init) => {
      calls.push({ url: url as URL, init: init as RequestInit });
      return response(JSON.stringify({ delay: 123 }));
    }) as unknown as typeof fetch;
    const client = createControllerClient({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      fetcher
    });

    await expect(
      client.testProxyDelay("Node A", "https://example.test/generate_204", 5000)
    ).resolves.toEqual({
      ok: true,
      status: 200,
      body: JSON.stringify({ delay: 123 })
    });

    expect(calls[0]?.url.toString()).toBe(
      "http://127.0.0.1:9090/proxies/Node%20A/delay?url=https%3A%2F%2Fexample.test%2Fgenerate_204&timeout=5000"
    );
    expect(calls[0]?.init.method).toBe("GET");
    expect(calls[0]?.init.headers).toEqual({
      Authorization: "Bearer secret-value",
      "Content-Type": "application/json"
    });
  });

  it("restarts controller through POST /restart with optional config path", async () => {
    const calls: RequestInit[] = [];
    const fetcher = vi.fn(async (_url, init) => {
      calls.push(init as RequestInit);
      return response("ok");
    }) as unknown as typeof fetch;
    const client = createControllerClient({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      fetcher
    });

    await client.restart("C:\\MioProxy\\active.yaml");

    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.body).toBe(JSON.stringify({ path: "C:\\MioProxy\\active.yaml" }));
  });

  it("returns failure details for non-2xx responses", async () => {
    const fetcher = vi.fn(async () => response("bad config", { ok: false, status: 400 })) as unknown as typeof fetch;
    const client = createControllerClient({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      fetcher
    });

    const result = await client.reloadConfig("active.yaml");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
      expect(result.body).toBe("bad config");
      expect(result.timedOut).toBe(false);
      expect(result.error.message).toContain("HTTP 400");
    }
  });

  it("reports timeout failures", async () => {
    const fetcher = vi.fn(async () => {
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const client = createControllerClient({
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret-value",
      timeoutMs: 25,
      fetcher
    });

    const result = await client.reloadConfig("active.yaml");

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.timedOut).toBe(true);
      expect(result.error.message).toContain("timed out");
    }
  });

  it("requires a non-empty secret", () => {
    expect(() =>
      createControllerClient({
        baseUrl: "http://127.0.0.1:9090",
        secret: " "
      })
    ).toThrow("Controller secret is required");
  });

  it("rejects 0.0.0.0 controller addresses", () => {
    expect(() =>
      createControllerClient({
        baseUrl: "http://0.0.0.0:9090",
        secret: "secret-value"
      })
    ).toThrow("must not use 0.0.0.0");
  });
});
