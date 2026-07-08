import { describe, expect, it } from "vitest";
import { checkMihomoConfig } from "./checker.js";
import type { CommandRunner } from "../types.js";

describe("checkMihomoConfig", () => {
  it("passes mihomo -t arguments to the runner", async () => {
    const calls: string[][] = [];
    const runner: CommandRunner = async (_command, args) => {
      calls.push(args);
      return { exitCode: 0, stdout: "ok", stderr: "", timedOut: false };
    };

    await expect(
      checkMihomoConfig({
        binaryPath: "mihomo.exe",
        configPath: "active.yaml",
        dataDir: "work",
        runner
      })
    ).resolves.toEqual({ ok: true, stdout: "ok", stderr: "" });

    expect(calls).toEqual([["-t", "-f", "active.yaml", "-d", "work"]]);
  });

  it("returns stdout and stderr on failure", async () => {
    const runner: CommandRunner = async () => ({
      exitCode: 1,
      stdout: "deprecated field",
      stderr: "panic: lightgbm",
      timedOut: false
    });

    const result = await checkMihomoConfig({
      binaryPath: "mihomo.exe",
      configPath: "active.yaml",
      dataDir: "work",
      runner
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.stdout).toContain("deprecated");
      expect(result.stderr).toContain("lightgbm");
      expect(result.timedOut).toBe(false);
    }
  });

  it("reports timeout failures", async () => {
    const runner: CommandRunner = async () => ({
      exitCode: null,
      stdout: "",
      stderr: "",
      timedOut: true
    });

    const result = await checkMihomoConfig({
      binaryPath: "mihomo.exe",
      configPath: "active.yaml",
      dataDir: "work",
      timeoutMs: 50,
      runner
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toContain("timed out");
      expect(result.timedOut).toBe(true);
    }
  });
});
