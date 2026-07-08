import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreLogStore } from "./logStore.js";
import { createProcessLogCollector } from "./processLogCollector.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-process-logs-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createProcessLogCollector", () => {
  it("appends stdout and stderr lines to the core log store", async () => {
    const store = createCoreLogStore(tempDir);
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    const collector = createProcessLogCollector({
      profileId: "default",
      store,
      stdout,
      stderr,
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    stdout.write("[INFO] started\nWARN delayed");
    stderr.end("error: bind failed\n");
    stdout.end(" route\n");

    await collector.done;

    const logs = await store.read("default");
    expect(logs).toHaveLength(3);
    expect(logs).toEqual(
      expect.arrayContaining([
        {
          time: "2026-07-07T10:00:00.000Z",
          source: "process-stdout",
          level: "info",
          message: "[INFO] started"
        },
        {
          time: "2026-07-07T10:00:00.000Z",
          source: "process-stderr",
          level: "error",
          message: "error: bind failed"
        },
        {
          time: "2026-07-07T10:00:00.000Z",
          source: "process-stdout",
          level: "warning",
          message: "WARN delayed route"
        }
      ])
    );
  });

  it("flushes a partial line when stopped", async () => {
    const store = createCoreLogStore(tempDir);
    const stdout = new PassThrough();
    const collector = createProcessLogCollector({
      profileId: "default",
      store,
      stdout,
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    stdout.write("debug: waiting for controller");

    await collector.stop();

    await expect(store.read("default")).resolves.toEqual([
      {
        time: "2026-07-07T10:00:00.000Z",
        source: "process-stdout",
        level: "debug",
        message: "debug: waiting for controller"
      }
    ]);
  });

  it("records stream errors as log events", async () => {
    const store = createCoreLogStore(tempDir);
    const stderr = new PassThrough();
    const collector = createProcessLogCollector({
      profileId: "default",
      store,
      stderr,
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    stderr.destroy(new Error("reader failed"));

    await collector.done;

    await expect(store.read("default")).resolves.toEqual([
      {
        time: "2026-07-07T10:00:00.000Z",
        source: "process-stderr",
        level: "error",
        message: "log stream error: reader failed"
      }
    ]);
  });
});
