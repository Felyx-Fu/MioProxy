import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { RawProfileCache } from "./rawProfileCache.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-raw-cache-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("RawProfileCache", () => {
  it("returns null when a profile cache does not exist", async () => {
    await expect(new RawProfileCache(tempDir).read("default")).resolves.toBeNull();
  });

  it("stores raw subscription cache under a sanitized profile path", async () => {
    const cache = new RawProfileCache(tempDir);

    await cache.write("bad/profile", "rules:\n  - MATCH,DIRECT\n");

    await expect(cache.read("bad/profile")).resolves.toContain("MATCH,DIRECT");
    await expect(readFile(join(tempDir, "profiles", "bad_profile", "raw.yaml"), "utf8")).resolves.toContain(
      "MATCH,DIRECT"
    );
  });
});
