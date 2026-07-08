import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigStore } from "../store/configStore.js";
import { validateCandidate } from "./validateCandidate.js";
import type { CommandRunner } from "../types.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-validate-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("validateCandidate", () => {
  it("checks the staged candidate path with mihomo -t args", async () => {
    const store = createConfigStore(tempDir);
    const candidatePath = await store.writeCandidate("default", "mixed-port: 7890\n");
    const runner = vi.fn(async () => ({
      exitCode: 0,
      stdout: "configuration is valid",
      stderr: "",
      timedOut: false
    })) as unknown as CommandRunner;

    const result = await validateCandidate({
      profileId: "default",
      store,
      binaryPath: "mihomo.exe",
      dataDir: join(tempDir, "work"),
      runner
    });

    expect(result).toEqual({
      ok: true,
      candidatePath,
      stdout: "configuration is valid",
      stderr: ""
    });
    expect(runner).toHaveBeenCalledWith(
      "mihomo.exe",
      ["-t", "-f", candidatePath, "-d", join(tempDir, "work")],
      { timeoutMs: 10_000 }
    );
  });

  it("returns offline-check failure output without touching active", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "global-client-fingerprint: chrome\n");
    const runner = vi.fn(async () => ({
      exitCode: 1,
      stdout: "deprecated field",
      stderr: "panic: lightgbm",
      timedOut: false
    })) as unknown as CommandRunner;

    const result = await validateCandidate({
      profileId: "default",
      store,
      binaryPath: "mihomo.exe",
      dataDir: join(tempDir, "work"),
      runner
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("offline-check");
      expect(result.stdout).toContain("deprecated");
      expect(result.stderr).toContain("lightgbm");
      expect(result.timedOut).toBe(false);
    }
    await expect(readFile(paths.activePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports timeout failures", async () => {
    const store = createConfigStore(tempDir);
    await store.writeCandidate("default", "mixed-port: 7890\n");
    const runner = vi.fn(async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true
    })) as unknown as CommandRunner;

    const result = await validateCandidate({
      profileId: "default",
      store,
      binaryPath: "mihomo.exe",
      dataDir: join(tempDir, "work"),
      timeoutMs: 25,
      runner
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timed out");
      expect(result.timedOut).toBe(true);
    }
    expect(runner).toHaveBeenCalledWith(
      "mihomo.exe",
      ["-t", "-f", store.pathsForProfile("default").candidatePath, "-d", join(tempDir, "work")],
      { timeoutMs: 25 }
    );
  });
});
