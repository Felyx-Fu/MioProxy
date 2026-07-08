import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPipelineHistoryStore } from "./pipelineHistoryStore.js";
import type { PipelineRunInput, PipelineRunResponse } from "../../shared/pipelineTypes.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-history-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function input(): PipelineRunInput {
  return {
    profileId: "default",
    subscription: { url: "https://secret.example.test/sub.yaml?token=private" },
    checker: { binaryPath: "mihomo.exe", dataDir: "work" },
    controller: { baseUrl: "http://127.0.0.1:9090", secret: "controller-secret" }
  };
}

describe("createPipelineHistoryStore", () => {
  it("returns empty history when no file exists", async () => {
    await expect(createPipelineHistoryStore(tempDir).list()).resolves.toEqual([]);
  });

  it("stores a success summary without secrets or full URL", async () => {
    const store = createPipelineHistoryStore(tempDir);
    const response: PipelineRunResponse = {
      ok: true,
      stage: "applied",
      mode: "hot-reload",
      activePath: "active.yaml",
      lastKnownGoodPath: "last-known-good.yaml",
      warnings: []
    };

    const record = await store.append(input(), response, new Date("2026-07-07T10:00:00.000Z"));

    expect(record).toMatchObject({
      profileId: "default",
      subscriptionHost: "secret.example.test",
      ok: true,
      stage: "applied",
      mode: "hot-reload"
    });
    const raw = await readFile(join(tempDir, "state", "pipeline-history.json"), "utf8");
    expect(raw).not.toContain("controller-secret");
    expect(raw).not.toContain("private");
    expect(raw).not.toContain("sub.yaml");
  });

  it("stores a failure summary with bundle path", async () => {
    const store = createPipelineHistoryStore(tempDir);
    const response: PipelineRunResponse = {
      ok: false,
      stage: "offline-check",
      error: { name: "Error", message: "Mihomo config check failed" },
      failureBundlePath: "failure.json"
    };

    const record = await store.append(input(), response, new Date("2026-07-07T10:00:00.000Z"));

    expect(record.ok).toBe(false);
    expect(record.failureBundlePath).toBe("failure.json");
    expect(record.errorMessage).toBe("Mihomo config check failed");
  });

  it("keeps only the latest 20 records", async () => {
    const store = createPipelineHistoryStore(tempDir);
    const response: PipelineRunResponse = {
      ok: false,
      stage: "offline-check",
      error: { name: "Error", message: "failed" },
      failureBundlePath: "failure.json"
    };

    for (let index = 0; index < 22; index += 1) {
      await store.append(
        { ...input(), profileId: `profile-${index}` },
        response,
        new Date(Date.UTC(2026, 6, 7, 10, 0, index))
      );
    }

    const history = await store.list();
    expect(history).toHaveLength(20);
    expect(history[0]?.profileId).toBe("profile-21");
    expect(history[19]?.profileId).toBe("profile-2");
  });
});
