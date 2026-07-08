import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createCoreLogStore } from "./logStore.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-logs-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createCoreLogStore", () => {
  it("returns empty logs for missing profile log", async () => {
    await expect(createCoreLogStore(tempDir).read("default")).resolves.toEqual([]);
  });

  it("appends and reads jsonl log events", async () => {
    const store = createCoreLogStore(tempDir);
    const path = await store.append("default", {
      time: "2026-07-07T10:00:00.000Z",
      source: "process-stderr",
      level: "error",
      message: "panic: lightgbm"
    });

    expect(path).toContain("default.jsonl");
    await expect(store.read("default")).resolves.toEqual([
      {
        time: "2026-07-07T10:00:00.000Z",
        source: "process-stderr",
        level: "error",
        message: "panic: lightgbm"
      }
    ]);
  });

  it("sanitizes profile id in log path", async () => {
    const path = await createCoreLogStore(tempDir).append("bad/profile", {
      time: "2026-07-07T10:00:00.000Z",
      source: "process-stdout",
      level: "info",
      message: "started"
    });

    expect(path).toContain("bad_profile.jsonl");
  });
});
