import { spawn } from "node:child_process";
import type { CommandResult, CommandRunner } from "../types.js";

export type CheckConfigResult =
  | { ok: true; stdout: string; stderr: string }
  | { ok: false; error: Error; stdout: string; stderr: string; timedOut: boolean };

export interface CheckConfigOptions {
  binaryPath: string;
  configPath: string;
  dataDir: string;
  timeoutMs?: number;
  runner?: CommandRunner;
}

export async function checkMihomoConfig(options: CheckConfigOptions): Promise<CheckConfigResult> {
  const timeoutMs = options.timeoutMs ?? 10_000;
  const args = ["-t", "-f", options.configPath, "-d", options.dataDir];
  const result = await (options.runner ?? runCommand)(options.binaryPath, args, { timeoutMs });

  if (result.exitCode === 0 && !result.timedOut) {
    return { ok: true, stdout: result.stdout, stderr: result.stderr };
  }

  const reason = result.timedOut
    ? `Mihomo config check timed out after ${timeoutMs}ms`
    : `Mihomo config check exited with code ${String(result.exitCode)}`;

  return {
    ok: false,
    error: new Error(reason),
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.timedOut
  };
}

async function runCommand(
  command: string,
  args: string[],
  options: { timeoutMs: number }
): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ exitCode, stdout, stderr, timedOut });
    });
  });
}
