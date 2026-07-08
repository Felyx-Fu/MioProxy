import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreLogStore } from "../logging/logStore.js";
import { startMihomoCore, type SpawnCoreProcess, type SpawnCoreProcessOptions } from "./coreProcess.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-core-process-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("startMihomoCore", () => {
  it("starts mihomo with active config args and collects process logs", async () => {
    const fake = new FakeSpawnedProcess();
    const calls: Array<{ command: string; args: string[]; options: SpawnCoreProcessOptions }> = [];
    const spawnProcess: SpawnCoreProcess = (command, args, options) => {
      calls.push({ command, args, options });
      return fake;
    };
    const store = createCoreLogStore(tempDir);

    const core = startMihomoCore({
      binaryPath: "mihomo.exe",
      configPath: "active.yaml",
      dataDir: "work",
      profileId: "default",
      logStore: store,
      spawnProcess
    });

    fake.stdout.write("[INFO] started\n");
    fake.stdout.end();
    fake.stderr.end();
    fake.close(0, null);

    await expect(core.waitForExit).resolves.toEqual({ exitCode: 0, signal: null });
    expect(calls).toEqual([
      {
        command: "mihomo.exe",
        args: ["-d", "work", "-f", "active.yaml"],
        options: { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }
      }
    ]);
    await expect(store.read("default")).resolves.toEqual([
      expect.objectContaining({
        source: "process-stdout",
        level: "info",
        message: "[INFO] started"
      })
    ]);
  });

  it("sends SIGTERM when stopping a running core", async () => {
    const fake = new FakeSpawnedProcess();
    const store = createCoreLogStore(tempDir);
    const core = startMihomoCore({
      binaryPath: "mihomo.exe",
      configPath: "active.yaml",
      dataDir: "work",
      profileId: "default",
      logStore: store,
      spawnProcess: () => fake
    });

    const stopped = core.stop({ timeoutMs: 1_000 });

    expect(fake.killSignals).toEqual(["SIGTERM"]);
    fake.stdout.end();
    fake.stderr.end();
    fake.close(null, "SIGTERM");

    await expect(stopped).resolves.toEqual({ exitCode: null, signal: "SIGTERM" });
  });

  it("sends SIGKILL when a stopped core does not exit before the timeout", async () => {
    const fake = new FakeSpawnedProcess();
    const store = createCoreLogStore(tempDir);
    const core = startMihomoCore({
      binaryPath: "mihomo.exe",
      configPath: "active.yaml",
      dataDir: "work",
      profileId: "default",
      logStore: store,
      spawnProcess: () => fake
    });

    const stopped = core.stop({ timeoutMs: 1 });
    await wait(5);
    expect(fake.killSignals).toEqual(["SIGTERM", "SIGKILL"]);

    fake.stdout.end();
    fake.stderr.end();
    fake.close(null, "SIGKILL");

    await expect(stopped).resolves.toEqual({ exitCode: null, signal: "SIGKILL" });
  });

  it("rejects empty launch paths", () => {
    expect(() =>
      startMihomoCore({
        binaryPath: " ",
        configPath: "active.yaml",
        dataDir: "work",
        profileId: "default",
        logStore: createCoreLogStore(tempDir),
        spawnProcess: () => new FakeSpawnedProcess()
      })
    ).toThrow("binaryPath is required");
  });
});

class FakeSpawnedProcess extends EventEmitter {
  readonly pid = 1234;
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly killSignals: Array<NodeJS.Signals | undefined> = [];

  kill(signal?: NodeJS.Signals): boolean {
    this.killSignals.push(signal);
    return true;
  }

  close(exitCode: number | null, signal: NodeJS.Signals | null): void {
    this.emit("close", exitCode, signal);
  }
}

function wait(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, timeoutMs);
  });
}
