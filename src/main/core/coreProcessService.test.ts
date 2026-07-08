import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  CoreProcessExit,
  MihomoCoreProcess,
  StartMihomoCoreOptions
} from "@mioproxy/core-runtime";
import { createCoreProcessService } from "./coreProcessService.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-core-service-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createCoreProcessService", () => {
  it("starts a core with the generated active config path", async () => {
    await writeActive("default");
    const calls: StartMihomoCoreOptions[] = [];
    const service = createCoreProcessService({
      appDataDir: tempDir,
      startCore: (options) => {
        calls.push(options);
        return new FakeCoreProcess(4321);
      },
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    const result = await service.start({
      profileId: "default",
      binaryPath: "mihomo.exe",
      dataDir: join(tempDir, "work")
    });

    expect(result.ok).toBe(true);
    expect(result.status).toMatchObject({
      profileId: "default",
      running: true,
      pid: 4321,
      startedAt: "2026-07-07T10:00:00.000Z"
    });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(call).toBeDefined();
    expect(call?.configPath).toBe(join(tempDir, "profiles", "default", "active.yaml"));
  });

  it("returns an IPC-safe error when active config is missing", async () => {
    const service = createCoreProcessService({ appDataDir: tempDir });

    const result = await service.start({
      profileId: "default",
      binaryPath: "mihomo.exe",
      dataDir: "work"
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("ENOENT");
      expect(result.status.running).toBe(false);
    }
  });

  it("stops a running core and records the last exit", async () => {
    await writeActive("default");
    const fake = new FakeCoreProcess(4321);
    const service = createCoreProcessService({
      appDataDir: tempDir,
      startCore: () => fake,
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    await service.start({ profileId: "default", binaryPath: "mihomo.exe", dataDir: "work" });
    const stopped = await service.stop("default");

    expect(fake.stopCalls).toBe(1);
    expect(stopped).toEqual({
      ok: true,
      status: {
        profileId: "default",
        running: false,
        activePath: join(tempDir, "profiles", "default", "active.yaml"),
        lastExit: {
          exitCode: null,
          signal: "SIGTERM",
          exitedAt: "2026-07-07T10:00:00.000Z"
        }
      }
    });
  });

  it("returns existing running status when started twice", async () => {
    await writeActive("default");
    let starts = 0;
    const service = createCoreProcessService({
      appDataDir: tempDir,
      startCore: () => {
        starts += 1;
        return new FakeCoreProcess(4321);
      }
    });

    await service.start({ profileId: "default", binaryPath: "mihomo.exe", dataDir: "work" });
    const second = await service.start({
      profileId: "default",
      binaryPath: "mihomo.exe",
      dataDir: "work"
    });

    expect(starts).toBe(1);
    expect(second.ok).toBe(true);
    expect(second.status.running).toBe(true);
  });

  it("stops all running cores", async () => {
    await writeActive("default");
    await writeActive("backup");
    const processes = [new FakeCoreProcess(1), new FakeCoreProcess(2)];
    const service = createCoreProcessService({
      appDataDir: tempDir,
      startCore: () => processes.shift() ?? new FakeCoreProcess(3),
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    await service.start({ profileId: "default", binaryPath: "mihomo.exe", dataDir: "work" });
    await service.start({ profileId: "backup", binaryPath: "mihomo.exe", dataDir: "work" });

    expect(service.hasRunning()).toBe(true);
    const statuses = await service.stopAll();

    expect(statuses).toHaveLength(2);
    expect(statuses.every((status) => !status.running)).toBe(true);
    expect(service.hasRunning()).toBe(false);
  });
});

class FakeCoreProcess implements MihomoCoreProcess {
  readonly waitForExit = new Promise<CoreProcessExit>(() => undefined);
  stopCalls = 0;

  constructor(readonly pid?: number) {}

  async stop(): Promise<CoreProcessExit> {
    this.stopCalls += 1;
    return { exitCode: null, signal: "SIGTERM" };
  }
}

async function writeActive(profileId: string): Promise<void> {
  const dir = join(tempDir, "profiles", profileId);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "active.yaml"), "mixed-port: 7890\n", "utf8");
}
