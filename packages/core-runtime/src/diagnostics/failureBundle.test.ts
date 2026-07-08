import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildFailureBundle,
  exportFailureReport,
  redactString,
  saveFailureBundle
} from "./failureBundle.js";
import type { RenderValidatePromoteAndApplyResult } from "../orchestrator/renderValidatePromoteAndApply.js";

let tempDir: string;

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), "mioproxy-bundle-"));
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

function failedResult(): Extract<RenderValidatePromoteAndApplyResult, { ok: false }> {
  return {
    ok: false,
    stage: "apply-active",
    error: new Error("Controller failed with Bearer top-secret-token"),
    render: {
      ok: true,
      candidatePath: "C:\\MioProxy\\candidate.yaml",
      rawSource: "network",
      downloadAttempts: 1,
      warnings: [{ code: "compat.smart-downgrade", message: "secret=abc123", path: "$.proxy-groups[0]" }]
    },
    validation: {
      ok: true,
      candidatePath: "C:\\MioProxy\\candidate.yaml",
      stdout: "ok",
      stderr: ""
    },
    promotion: {
      ok: true,
      candidatePath: "C:\\MioProxy\\candidate.yaml",
      activePath: "C:\\MioProxy\\active.yaml",
      stdout: "ok",
      stderr: ""
    },
    apply: {
      ok: false,
      stage: "restart",
      activePath: "C:\\MioProxy\\active.yaml",
      error: new Error("request failed"),
      rolledBack: false,
      reloadResult: {
        ok: false,
        timedOut: false,
        status: 401,
        body: "authorization: Bearer hidden",
        error: new Error("HTTP 401")
      }
    }
  };
}

describe("failure bundle diagnostics", () => {
  it("redacts bearer and query secrets from strings", () => {
    expect(
      redactString("Authorization: Bearer abc.def?x token=123 https://x.test?a=1&secret=abc")
    ).toBe("Authorization: Bearer [REDACTED]?x token=[REDACTED] https://x.test?a=1&secret=[REDACTED]");
  });

  it("builds a redacted bundle without raw config contents", () => {
    const bundle = buildFailureBundle(failedResult(), {
      createdAt: "2026-07-07T10:00:00.000Z",
      profileId: "default",
      sessionId: "session-1"
    });

    const serialized = JSON.stringify(bundle);
    expect(bundle.stage).toBe("apply-active");
    expect(serialized).not.toContain("top-secret-token");
    expect(serialized).not.toContain("abc123");
    expect(serialized).not.toContain("Bearer hidden");
    expect(serialized).toContain("[REDACTED]");
  });

  it("writes failure.json under a profile/session bundle directory", async () => {
    const result = await saveFailureBundle({
      rootDir: tempDir,
      profileId: "default/profile",
      sessionId: "session:1",
      result: failedResult(),
      now: new Date("2026-07-07T10:00:00.000Z")
    });

    expect(result.bundlePath.endsWith("failure.json")).toBe(true);
    expect(result.bundleDir).toContain("default_profile");
    expect(result.bundleDir).toContain("session_1");
    await expect(readFile(result.bundlePath, "utf8")).resolves.toContain("\"stage\": \"apply-active\"");
  });

  it("exports a redacted failure report from a managed bundle", async () => {
    const failure = await saveFailureBundle({
      rootDir: join(tempDir, "logs"),
      profileId: "default",
      sessionId: "session-1",
      result: failedResult(),
      now: new Date("2026-07-07T10:00:00.000Z")
    });

    const report = await exportFailureReport({
      rootDir: tempDir,
      profileId: "default",
      sessionId: "history-1",
      failureBundlePath: failure.bundlePath,
      history: [{ errorMessage: "token=history-secret" }],
      coreLogs: [{ message: "Authorization: Bearer log-secret" }],
      now: new Date("2026-07-07T10:05:00.000Z")
    });

    expect(report.files).toEqual(["summary.json", "failure.json", "history.json", "core-logs.json"]);
    const serialized = await readFile(join(report.reportDir, "core-logs.json"), "utf8");
    expect(serialized).not.toContain("log-secret");
    await expect(readFile(join(report.reportDir, "history.json"), "utf8")).resolves.not.toContain(
      "history-secret"
    );
  });

  it("refuses to export a failure bundle outside managed diagnostics", async () => {
    const outsideDir = await mkdtemp(join(tmpdir(), "mioproxy-outside-"));
    try {
      const outsideBundle = join(outsideDir, "failure.json");
      await mkdir(outsideDir, { recursive: true });
      await writeFile(outsideBundle, "{}", "utf8");

      await expect(
        exportFailureReport({
          rootDir: tempDir,
          profileId: "default",
          sessionId: "history-1",
          failureBundlePath: outsideBundle
        })
      ).rejects.toThrow("managed diagnostics");
    } finally {
      await rm(outsideDir, { recursive: true, force: true });
    }
  });
});
