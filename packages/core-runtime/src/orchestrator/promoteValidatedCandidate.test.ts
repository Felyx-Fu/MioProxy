import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigStore } from "../store/configStore.js";
import { promoteValidatedCandidate } from "./promoteValidatedCandidate.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-promote-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("promoteValidatedCandidate", () => {
  it("promotes candidate to active only after validation success", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "mixed-port: 7890\n");

    const result = await promoteValidatedCandidate({
      profileId: "default",
      store,
      validation: {
        ok: true,
        candidatePath: paths.candidatePath,
        stdout: "configuration is valid",
        stderr: ""
      }
    });

    expect(result).toEqual({
      ok: true,
      activePath: paths.activePath,
      candidatePath: paths.candidatePath,
      stdout: "configuration is valid",
      stderr: ""
    });
    await expect(readFile(paths.activePath, "utf8")).resolves.toBe("mixed-port: 7890\n");
    await expect(readFile(paths.lastKnownGoodPath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not promote when validation failed", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "global-client-fingerprint: chrome\n");

    const result = await promoteValidatedCandidate({
      profileId: "default",
      store,
      validation: {
        ok: false,
        stage: "offline-check",
        candidatePath: paths.candidatePath,
        error: new Error("Mihomo config check exited with code 1"),
        stdout: "deprecated field",
        stderr: "panic: lightgbm",
        timedOut: false
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("offline-check");
      expect(result.stdout).toContain("deprecated");
      expect(result.stderr).toContain("lightgbm");
    }
    await expect(readFile(paths.activePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(paths.candidatePath, "utf8")).resolves.toBe(
      "global-client-fingerprint: chrome\n"
    );
  });

  it("returns promote-active when candidate cannot be renamed", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");

    const result = await promoteValidatedCandidate({
      profileId: "default",
      store,
      validation: {
        ok: true,
        candidatePath: paths.candidatePath,
        stdout: "",
        stderr: ""
      }
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("promote-active");
      expect(result.error.message).toBeTruthy();
    }
    await expect(readFile(paths.activePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});
