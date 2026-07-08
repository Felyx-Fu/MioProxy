import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createConfigStore } from "../store/configStore.js";
import { renderValidateAndPromote } from "./renderValidateAndPromote.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-prepare-active-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

describe("renderValidateAndPromote", () => {
  it("renders, validates, and promotes active config without applying through controller", async () => {
    const store = createConfigStore(tempDir);

    const result = await renderValidateAndPromote({
      profileId: "default",
      store,
      render: async () => ({
        ok: true,
        renderedYaml: "mixed-port: 7890\n",
        rawSource: "cache",
        downloadAttempts: 1,
        warnings: []
      }),
      checker: {
        binaryPath: "mihomo.exe",
        dataDir: "work",
        runner: vi.fn(async () => ({ exitCode: 0, stdout: "ok", stderr: "", timedOut: false }))
      }
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      await expect(readFile(result.promotion.activePath, "utf8")).resolves.toContain("mixed-port");
    }
  });

  it("returns offline-check failures without promoting active config", async () => {
    const result = await renderValidateAndPromote({
      profileId: "default",
      store: createConfigStore(tempDir),
      render: async () => ({
        ok: true,
        renderedYaml: "bad: yaml\n",
        rawSource: "cache",
        downloadAttempts: 1,
        warnings: []
      }),
      checker: {
        binaryPath: "mihomo.exe",
        dataDir: "work",
        runner: vi.fn(async () => ({
          exitCode: 1,
          stdout: "",
          stderr: "parse failed",
          timedOut: false
        }))
      }
    });

    expect(result).toMatchObject({
      ok: false,
      stage: "offline-check",
      validation: {
        ok: false,
        stderr: "parse failed"
      }
    });
  });
});
