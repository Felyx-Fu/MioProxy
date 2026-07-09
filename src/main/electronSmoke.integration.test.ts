import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SMOKE_PREFIX = "MIOPROXY_ELECTRON_SMOKE_RESULT ";
const runSmoke = process.env.MIOPROXY_ELECTRON_SMOKE === "1";

let userDataDir: string;

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), "mioproxy-electron-smoke-"));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

describe.skipIf(!runSmoke)("Electron smoke", () => {
  it("loads the production renderer and exposes the preload bridge", async () => {
    await access(join(process.cwd(), "out", "main", "main.js"));

    const result = await runElectronSmoke();

    expect(result.exitCode).toBe(0);
    expect(result.payload).toMatchObject({
      title: "MioProxy",
      hasAppShell: true,
      hasMainContent: true,
      initialHash: "#/dashboard",
      hasDashboard: true,
      hasDashboardGrid: true,
      hasActionLabels: true,
      hasSidebarStatusCards: true,
      hasSidebarNavigation: true,
      profilesHash: "#/profiles",
      profilesPageRendered: true,
      dashboardHiddenAfterNavigation: true,
      hasActiveProfilesNav: true,
      hasSubscriptionSchedule: true,
      hasRendererCss: true,
      hasPreloadBridge: true,
      hasHiddenApplicationMenu: true,
      platform: process.platform
    });
  }, 30_000);
});

function runElectronSmoke(): Promise<{
  exitCode: number | null;
  payload: Record<string, unknown>;
}> {
  return new Promise((resolve, reject) => {
    const child = spawn(electronExecutablePath(), [join(process.cwd(), "out", "main", "main.js")], {
      cwd: process.cwd(),
      env: {
        ...process.env,
        MIOPROXY_ELECTRON_SMOKE: "1",
        MIOPROXY_ELECTRON_SMOKE_USER_DATA_DIR: userDataDir
      },
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      const line = stdout
        .split(/\r?\n/)
        .find((item) => item.startsWith(SMOKE_PREFIX));
      if (!line) {
        reject(new Error(`Electron smoke did not produce a result. stderr: ${stderr}`));
        return;
      }

      resolve({
        exitCode,
        payload: JSON.parse(line.slice(SMOKE_PREFIX.length)) as Record<string, unknown>
      });
    });
  });
}

function electronExecutablePath(): string {
  if (process.platform === "win32") {
    return join(process.cwd(), "node_modules", "electron", "dist", "electron.exe");
  }

  return join(process.cwd(), "node_modules", ".bin", "electron");
}
