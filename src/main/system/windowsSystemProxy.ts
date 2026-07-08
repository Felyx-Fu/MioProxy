import { spawn } from "node:child_process";

export interface WindowsSystemProxyState {
  enabled: boolean;
  server?: string;
  bypass?: string;
}

export interface WindowsSystemProxySnapshot extends WindowsSystemProxyState {
  capturedAt: string;
}

export interface WindowsSystemProxyCommandResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export type WindowsSystemProxyRunner = (
  command: string,
  args: string[]
) => Promise<WindowsSystemProxyCommandResult>;

export interface WindowsSystemProxyOptions {
  runner?: WindowsSystemProxyRunner;
  now?: () => Date;
}

export interface EnableWindowsSystemProxyOptions extends WindowsSystemProxyOptions {
  host: string;
  port: number;
  bypass?: string;
}

const INTERNET_SETTINGS_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings";

export async function readWindowsSystemProxy(
  options: WindowsSystemProxyOptions = {}
): Promise<WindowsSystemProxySnapshot> {
  const runner = options.runner ?? runCommand;
  const now = options.now ?? (() => new Date());
  const [enable, server, bypass] = await Promise.all([
    queryRegistryValue("ProxyEnable", runner),
    queryRegistryValue("ProxyServer", runner),
    queryRegistryValue("ProxyOverride", runner)
  ]);

  return {
    enabled: parseDword(enable) === 1,
    server: server?.value,
    bypass: bypass?.value,
    capturedAt: now().toISOString()
  };
}

export async function enableWindowsSystemProxy(
  options: EnableWindowsSystemProxyOptions
): Promise<WindowsSystemProxySnapshot> {
  const runner = options.runner ?? runCommand;
  const previous = await readWindowsSystemProxy({ runner, now: options.now });
  const server = `${normalizeHost(options.host)}:${normalizePort(options.port)}`;
  const bypass = options.bypass?.trim() || "localhost;127.*;<local>";

  try {
    await setRegistryDword("ProxyEnable", 1, runner);
    await setRegistryString("ProxyServer", server, runner);
    await setRegistryString("ProxyOverride", bypass, runner);
    await notifyProxySettingsChanged(runner);
    return readWindowsSystemProxy({ runner, now: options.now });
  } catch (error) {
    await restoreWindowsSystemProxy(previous, { runner }).catch(() => undefined);
    throw error;
  }
}

export async function disableWindowsSystemProxy(
  options: WindowsSystemProxyOptions = {}
): Promise<WindowsSystemProxySnapshot> {
  const runner = options.runner ?? runCommand;
  const previous = await readWindowsSystemProxy({ runner, now: options.now });

  try {
    await setRegistryDword("ProxyEnable", 0, runner);
    await notifyProxySettingsChanged(runner);
    return readWindowsSystemProxy({ runner, now: options.now });
  } catch (error) {
    await restoreWindowsSystemProxy(previous, { runner }).catch(() => undefined);
    throw error;
  }
}

export async function restoreWindowsSystemProxy(
  snapshot: WindowsSystemProxySnapshot,
  options: WindowsSystemProxyOptions = {}
): Promise<WindowsSystemProxySnapshot> {
  const runner = options.runner ?? runCommand;
  await setRegistryDword("ProxyEnable", snapshot.enabled ? 1 : 0, runner);
  await restoreOptionalString("ProxyServer", snapshot.server, runner);
  await restoreOptionalString("ProxyOverride", snapshot.bypass, runner);
  await notifyProxySettingsChanged(runner);
  return readWindowsSystemProxy({ runner, now: options.now });
}

async function queryRegistryValue(
  name: string,
  runner: WindowsSystemProxyRunner
): Promise<{ type: string; value: string } | undefined> {
  const result = await runner("reg.exe", ["query", INTERNET_SETTINGS_KEY, "/v", name]);
  if (result.exitCode !== 0) {
    return undefined;
  }

  return parseRegQueryValue(result.stdout, name);
}

async function setRegistryDword(
  name: string,
  value: 0 | 1,
  runner: WindowsSystemProxyRunner
): Promise<void> {
  await expectSuccess(
    runner("reg.exe", [
      "add",
      INTERNET_SETTINGS_KEY,
      "/v",
      name,
      "/t",
      "REG_DWORD",
      "/d",
      String(value),
      "/f"
    ]),
    `set ${name}`
  );
}

async function setRegistryString(
  name: string,
  value: string,
  runner: WindowsSystemProxyRunner
): Promise<void> {
  await expectSuccess(
    runner("reg.exe", [
      "add",
      INTERNET_SETTINGS_KEY,
      "/v",
      name,
      "/t",
      "REG_SZ",
      "/d",
      value,
      "/f"
    ]),
    `set ${name}`
  );
}

async function deleteRegistryValue(name: string, runner: WindowsSystemProxyRunner): Promise<void> {
  const result = await runner("reg.exe", ["delete", INTERNET_SETTINGS_KEY, "/v", name, "/f"]);
  if (result.exitCode !== 0 && !result.stderr.toLowerCase().includes("unable to find")) {
    throw new Error(`delete ${name} failed: ${result.stderr || result.stdout}`);
  }
}

async function restoreOptionalString(
  name: string,
  value: string | undefined,
  runner: WindowsSystemProxyRunner
): Promise<void> {
  if (value === undefined) {
    await deleteRegistryValue(name, runner);
    return;
  }

  await setRegistryString(name, value, runner);
}

async function notifyProxySettingsChanged(runner: WindowsSystemProxyRunner): Promise<void> {
  await expectSuccess(
    runner("powershell.exe", [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      [
        "Add-Type -Namespace Native -Name Wininet -MemberDefinition '[DllImport(\"wininet.dll\", SetLastError=true)] public static extern bool InternetSetOption(IntPtr hInternet, int dwOption, IntPtr lpBuffer, int dwBufferLength);';",
        "[Native.Wininet]::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0) | Out-Null;",
        "[Native.Wininet]::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0) | Out-Null;"
      ].join(" ")
    ]),
    "notify proxy settings"
  );
}

function parseRegQueryValue(
  stdout: string,
  name: string
): { type: string; value: string } | undefined {
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(name)) {
      continue;
    }

    const parts = trimmed.split(/\s{2,}/);
    if (parts.length >= 3) {
      return { type: parts[1] ?? "", value: parts.slice(2).join("  ") };
    }
  }

  return undefined;
}

function parseDword(value: { type: string; value: string } | undefined): number {
  if (!value) {
    return 0;
  }
  if (value.value.toLowerCase().startsWith("0x")) {
    return Number.parseInt(value.value, 16);
  }
  return Number.parseInt(value.value, 10);
}

async function expectSuccess(
  promise: Promise<WindowsSystemProxyCommandResult>,
  label: string
): Promise<void> {
  const result = await promise;
  if (result.exitCode !== 0) {
    throw new Error(`${label} failed: ${result.stderr || result.stdout}`);
  }
}

function normalizeHost(host: string): string {
  const trimmed = host.trim();
  if (!trimmed) {
    throw new Error("Proxy host is required");
  }
  return trimmed;
}

function normalizePort(port: number): number {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("Proxy port must be between 1 and 65535");
  }
  return port;
}

function runCommand(
  command: string,
  args: string[]
): Promise<WindowsSystemProxyCommandResult> {
  if (process.platform !== "win32") {
    return Promise.reject(new Error("Windows system proxy is only supported on Windows"));
  }

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      windowsHide: true,
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
      resolve({ exitCode, stdout, stderr });
    });
  });
}
