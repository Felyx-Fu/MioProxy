import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigStore } from "../store/configStore.js";
import { renderAndStage } from "./renderAndStage.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-stage-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("renderAndStage", () => {
  it("writes rendered yaml to candidate without promoting active", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    const result = await renderAndStage({
      profileId: "default",
      store,
      render: vi.fn(async () => ({
        ok: true,
        renderedYaml: "rules:\n  - DOMAIN,example.com,DIRECT\n  - MATCH,PROXY\n",
        rawSource: "network",
        downloadAttempts: 1,
        warnings: [
          {
            code: "deprecated.global-client-fingerprint",
            message: "Removed deprecated global-client-fingerprint from root config.",
            path: "$.global-client-fingerprint"
          }
        ]
      }))
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.candidatePath).toBe(paths.candidatePath);
      expect(result.warnings.map((warning) => warning.code)).toContain(
        "deprecated.global-client-fingerprint"
      );
    }

    await expect(readFile(paths.candidatePath, "utf8")).resolves.toContain(
      "DOMAIN,example.com,DIRECT"
    );
    await expect(readFile(paths.activePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not write candidate when render fails", async () => {
    const store = createConfigStore(tempDir);
    const paths = store.pathsForProfile("default");
    const result = await renderAndStage({
      profileId: "default",
      store,
      render: vi.fn(async () => ({
        ok: false,
        stage: "parse",
        error: new Error("YAML root must be an object"),
        downloadAttempts: 1
      }))
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("parse");
    }
    await expect(readFile(paths.candidatePath, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("returns stage-candidate when candidate write fails", async () => {
    const result = await renderAndStage({
      profileId: "default",
      store: {
        pathsForProfile: createConfigStore(tempDir).pathsForProfile,
        writeCandidate: async () => {
          throw new Error("disk full");
        },
        promoteCandidateToActive: async () => "active.yaml",
        markLastKnownGood: async () => "last-known-good.yaml",
        rollbackToLastKnownGood: async () => null
      },
      render: vi.fn(async () => ({
        ok: true,
        renderedYaml: "rules:\n  - MATCH,DIRECT\n",
        rawSource: "network",
        downloadAttempts: 1,
        warnings: []
      }))
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stage).toBe("stage-candidate");
      expect(result.error.message).toBe("disk full");
    }
  });
});
