import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createConfigStore } from "./configStore.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-store-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("createConfigStore", () => {
  it("writes candidate without touching active", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "mixed-port: 7890\n");

    await expect(readFile(paths.candidatePath, "utf8")).resolves.toBe("mixed-port: 7890\n");
    await expect(readFile(paths.activePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("promotes active and marks last-known-good", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "mixed-port: 7890\n");
    await store.promoteCandidateToActive("default");
    await store.markLastKnownGood("default");

    await expect(readFile(paths.activePath, "utf8")).resolves.toBe("mixed-port: 7890\n");
    await expect(readFile(paths.lastKnownGoodPath, "utf8")).resolves.toBe("mixed-port: 7890\n");
  });

  it("rolls back active from last-known-good", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    await store.writeCandidate("default", "mixed-port: 7890\n");
    await store.promoteCandidateToActive("default");
    await store.markLastKnownGood("default");
    await writeFile(paths.activePath, "mixed-port: 9999\n");

    await expect(store.rollbackToLastKnownGood("default")).resolves.toBe(paths.activePath);
    await expect(readFile(paths.activePath, "utf8")).resolves.toBe("mixed-port: 7890\n");
  });
});
