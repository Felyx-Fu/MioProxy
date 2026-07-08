import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createControllerLogCollector } from "./controllerLogCollector.js";
import { createCoreLogStore } from "./logStore.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-controller-logs-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createControllerLogCollector", () => {
  it("streams controller log lines into the core log store", async () => {
    const store = createCoreLogStore(tempDir);
    const fetcher = vi.fn(async () =>
      responseFromLines([
        JSON.stringify({ level: "info", message: "started", fields: ["a"] }),
        JSON.stringify({ type: "warning", payload: "slow dns" })
      ])
    ) as unknown as typeof fetch;

    const collector = createControllerLogCollector({
      profileId: "default",
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      level: "info",
      store,
      fetcher
    });

    await collector.done;

    expect(fetcher).toHaveBeenCalledWith(new URL("http://127.0.0.1:9090/logs?format=structured&level=info"), {
      method: "GET",
      headers: { Authorization: "Bearer secret" },
      signal: expect.any(AbortSignal)
    });
    await expect(store.read("default")).resolves.toEqual([
      expect.objectContaining({
        source: "controller-logs",
        level: "info",
        message: "started",
        fields: { items: ["a"] }
      }),
      expect.objectContaining({
        source: "controller-logs",
        level: "warning",
        message: "slow dns"
      })
    ]);
  });

  it("rejects 0.0.0.0 controller addresses", () => {
    expect(() =>
      createControllerLogCollector({
        profileId: "default",
        baseUrl: "http://0.0.0.0:9090",
        secret: "secret",
        store: createCoreLogStore(tempDir)
      })
    ).toThrow("Controller baseUrl must not use 0.0.0.0");
  });

  it("requires controller secret", () => {
    expect(() =>
      createControllerLogCollector({
        profileId: "default",
        baseUrl: "http://127.0.0.1:9090",
        secret: " ",
        store: createCoreLogStore(tempDir)
      })
    ).toThrow("Controller secret is required");
  });

  it("rejects non-success responses", async () => {
    const collector = createControllerLogCollector({
      profileId: "default",
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      store: createCoreLogStore(tempDir),
      fetcher: vi.fn(async () => ({ ok: false, status: 401, body: null }) as Response) as unknown as typeof fetch
    });

    await expect(collector.done).rejects.toThrow("HTTP 401");
  });
});

function responseFromLines(lines: string[]): Response {
  const encoder = new TextEncoder();
  return {
    ok: true,
    status: 200,
    body: new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(`${lines.join("\n")}\n`));
        controller.close();
      }
    })
  } as Response;
}
