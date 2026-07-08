import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  ControllerLogCollector,
  CreateControllerLogCollectorOptions
} from "@mioproxy/core-runtime";
import { createControllerLogService } from "./controllerLogService.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-controller-log-service-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createControllerLogService", () => {
  it("starts controller log collection", async () => {
    const calls: CreateControllerLogCollectorOptions[] = [];
    const service = createControllerLogService({
      appDataDir: tempDir,
      createCollector: (options) => {
        calls.push(options);
        return new FakeControllerLogCollector();
      },
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    const result = await service.start({
      profileId: "default",
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      level: "info"
    });

    expect(result).toMatchObject({
      ok: true,
      status: {
        profileId: "default",
        running: true,
        level: "info",
        startedAt: "2026-07-07T10:00:00.000Z"
      }
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      profileId: "default",
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret",
      level: "info"
    });
  });

  it("stops running controller log collection", async () => {
    const collector = new FakeControllerLogCollector();
    const service = createControllerLogService({
      appDataDir: tempDir,
      createCollector: () => collector
    });

    await service.start({
      profileId: "default",
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    });
    const stopped = await service.stop("default");

    expect(collector.stopCalls).toBe(1);
    expect(stopped).toEqual({
      ok: true,
      status: {
        profileId: "default",
        running: false
      }
    });
  });

  it("records collector failures as last error", async () => {
    const collector = new FakeControllerLogCollector(Promise.reject(new Error("HTTP 401")));
    const service = createControllerLogService({
      appDataDir: tempDir,
      createCollector: () => collector,
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    await service.start({
      profileId: "default",
      baseUrl: "http://127.0.0.1:9090",
      secret: "secret"
    });
    await collector.done.catch(() => undefined);
    await wait(0);

    expect(service.status("default")).toEqual({
      profileId: "default",
      running: false,
      lastError: {
        message: "HTTP 401",
        occurredAt: "2026-07-07T10:00:00.000Z"
      }
    });
  });

  it("stops all running collectors", async () => {
    const collectors = [new FakeControllerLogCollector(), new FakeControllerLogCollector()];
    const service = createControllerLogService({
      appDataDir: tempDir,
      createCollector: () => collectors.shift() ?? new FakeControllerLogCollector()
    });

    await service.start({ profileId: "default", baseUrl: "http://127.0.0.1:9090", secret: "secret" });
    await service.start({ profileId: "backup", baseUrl: "http://127.0.0.1:9090", secret: "secret" });

    expect(service.hasRunning()).toBe(true);
    const statuses = await service.stopAll();

    expect(statuses).toHaveLength(2);
    expect(statuses.every((status) => !status.running)).toBe(true);
    expect(service.hasRunning()).toBe(false);
  });
});

class FakeControllerLogCollector implements ControllerLogCollector {
  stopCalls = 0;

  constructor(readonly done: Promise<void> = new Promise(() => undefined)) {}

  async stop(): Promise<void> {
    this.stopCalls += 1;
  }
}

function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
