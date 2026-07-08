import { describe, expect, it, vi } from "vitest";
import {
  disableWindowsSystemProxy,
  enableWindowsSystemProxy,
  readWindowsSystemProxy,
  restoreWindowsSystemProxy,
  type WindowsSystemProxyCommandResult,
  type WindowsSystemProxyRunner
} from "./windowsSystemProxy.js";

describe("windows system proxy registry manager", () => {
  it("reads current WinINET proxy state", async () => {
    const runner = createRegistryRunner({
      ProxyEnable: { type: "REG_DWORD", value: "0x1" },
      ProxyServer: { type: "REG_SZ", value: "127.0.0.1:7890" },
      ProxyOverride: { type: "REG_SZ", value: "localhost;127.*;<local>" }
    });

    await expect(
      readWindowsSystemProxy({
        runner,
        now: () => new Date("2026-07-07T10:00:00.000Z")
      })
    ).resolves.toEqual({
      enabled: true,
      server: "127.0.0.1:7890",
      bypass: "localhost;127.*;<local>",
      capturedAt: "2026-07-07T10:00:00.000Z"
    });
  });

  it("enables system proxy and notifies WinINET", async () => {
    const calls: string[][] = [];
    const runner = createRegistryRunner({}, calls);

    const state = await enableWindowsSystemProxy({
      host: "127.0.0.1",
      port: 7890,
      runner,
      now: () => new Date("2026-07-07T10:00:00.000Z")
    });

    expect(state).toMatchObject({
      enabled: true,
      server: "127.0.0.1:7890",
      bypass: "localhost;127.*;<local>"
    });
    expect(calls).toContainEqual([
      "reg.exe",
      "add",
      expect.any(String),
      "/v",
      "ProxyEnable",
      "/t",
      "REG_DWORD",
      "/d",
      "1",
      "/f"
    ]);
    expect(calls.some((call) => call[0] === "powershell.exe")).toBe(true);
  });

  it("disables system proxy without deleting server values", async () => {
    const runner = createRegistryRunner({
      ProxyEnable: { type: "REG_DWORD", value: "0x1" },
      ProxyServer: { type: "REG_SZ", value: "127.0.0.1:7890" }
    });

    await expect(disableWindowsSystemProxy({ runner })).resolves.toMatchObject({
      enabled: false,
      server: "127.0.0.1:7890"
    });
  });

  it("restores a snapshot and deletes optional values that were absent", async () => {
    const runner = createRegistryRunner({
      ProxyEnable: { type: "REG_DWORD", value: "0x1" },
      ProxyServer: { type: "REG_SZ", value: "127.0.0.1:7890" },
      ProxyOverride: { type: "REG_SZ", value: "localhost" }
    });

    await expect(
      restoreWindowsSystemProxy(
        {
          enabled: false,
          capturedAt: "2026-07-07T10:00:00.000Z"
        },
        { runner }
      )
    ).resolves.toMatchObject({
      enabled: false,
      server: undefined,
      bypass: undefined
    });
  });

  it("rolls back when enabling fails midway", async () => {
    const calls: string[][] = [];
    const runner = createRegistryRunner(
      {
        ProxyEnable: { type: "REG_DWORD", value: "0x0" },
        ProxyServer: { type: "REG_SZ", value: "old:8080" }
      },
      calls,
      { failSetName: "ProxyServer" }
    );

    await expect(
      enableWindowsSystemProxy({
        host: "127.0.0.1",
        port: 7890,
        runner
      })
    ).rejects.toThrow("set ProxyServer failed");

    expect(calls).toContainEqual([
      "reg.exe",
      "add",
      expect.any(String),
      "/v",
      "ProxyEnable",
      "/t",
      "REG_DWORD",
      "/d",
      "0",
      "/f"
    ]);
  });

  it("validates proxy port", async () => {
    await expect(
      enableWindowsSystemProxy({
        host: "127.0.0.1",
        port: 70000,
        runner: createRegistryRunner({})
      })
    ).rejects.toThrow("Proxy port must be between 1 and 65535");
  });
});

function createRegistryRunner(
  initial: Record<string, { type: string; value: string }>,
  calls: string[][] = [],
  options: { failSetName?: string } = {}
): WindowsSystemProxyRunner {
  const values = new Map(Object.entries(initial));
  return vi.fn(async (command, args) => {
    calls.push([command, ...args]);
    if (command === "powershell.exe") {
      return ok("");
    }

    const action = args[0];
    const name = valueAfter(args, "/v");
    if (action === "query" && name) {
      const value = values.get(name);
      if (!value) {
        return fail("ERROR: The system was unable to find the specified registry key or value.");
      }
      return ok(`HKEY_CURRENT_USER\\Example\n    ${name}    ${value.type}    ${value.value}\n`);
    }

    if (action === "add" && name) {
      if (name === options.failSetName) {
        return fail("write failed");
      }
      values.set(name, {
        type: valueAfter(args, "/t") ?? "REG_SZ",
        value: valueAfter(args, "/d") ?? ""
      });
      return ok("The operation completed successfully.");
    }

    if (action === "delete" && name) {
      values.delete(name);
      return ok("The operation completed successfully.");
    }

    return fail("unknown command");
  }) as WindowsSystemProxyRunner;
}

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index === -1 ? undefined : args[index + 1];
}

function ok(stdout: string): WindowsSystemProxyCommandResult {
  return { exitCode: 0, stdout, stderr: "" };
}

function fail(stderr: string): WindowsSystemProxyCommandResult {
  return { exitCode: 1, stdout: "", stderr };
}
