export interface ControllerClientOptions {
  baseUrl: string;
  secret: string;
  timeoutMs?: number;
  fetcher?: typeof fetch;
}

export type ControllerClientResult =
  | { ok: true; status: number; body: string }
  | { ok: false; error: Error; status?: number; body?: string; timedOut: boolean };

export interface ControllerClient {
  getConfigs(): Promise<ControllerClientResult>;
  getVersion(): Promise<ControllerClientResult>;
  getTraffic(): Promise<ControllerClientResult>;
  getConnections(): Promise<ControllerClientResult>;
  getProxies(): Promise<ControllerClientResult>;
  getRules(): Promise<ControllerClientResult>;
  getRuleProviders(): Promise<ControllerClientResult>;
  switchProxy(groupName: string, proxyName: string): Promise<ControllerClientResult>;
  testProxyDelay(proxyName: string, url: string, timeoutMs: number): Promise<ControllerClientResult>;
  reloadConfig(configPath: string): Promise<ControllerClientResult>;
  restart(configPath?: string): Promise<ControllerClientResult>;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export function createControllerClient(options: ControllerClientOptions): ControllerClient {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const secret = normalizeSecret(options.secret);
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetcher = options.fetcher ?? fetch;

  return {
    getConfigs(): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "GET",
        pathname: "/configs"
      });
    },

    getVersion(): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "GET",
        pathname: "/version"
      });
    },

    getTraffic(): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "GET",
        pathname: "/traffic"
      });
    },

    getConnections(): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "GET",
        pathname: "/connections"
      });
    },

    getProxies(): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "GET",
        pathname: "/proxies"
      });
    },

    getRules(): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "GET",
        pathname: "/rules"
      });
    },

    getRuleProviders(): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "GET",
        pathname: "/providers/rules"
      });
    },

    switchProxy(groupName: string, proxyName: string): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "PUT",
        pathname: `/proxies/${encodeURIComponent(groupName)}`,
        body: { name: proxyName }
      });
    },

    testProxyDelay(proxyName: string, url: string, timeoutMs: number): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "GET",
        pathname: `/proxies/${encodeURIComponent(proxyName)}/delay`,
        searchParams: {
          url,
          timeout: String(timeoutMs)
        }
      });
    },

    reloadConfig(configPath: string): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "PUT",
        pathname: "/configs",
        searchParams: { force: "true" },
        body: { path: configPath }
      });
    },

    restart(configPath?: string): Promise<ControllerClientResult> {
      return request({
        baseUrl,
        fetcher,
        secret,
        timeoutMs,
        method: "POST",
        pathname: "/restart",
        body: configPath ? { path: configPath } : undefined
      });
    }
  };
}

async function request(options: {
  baseUrl: URL;
  fetcher: typeof fetch;
  secret: string;
  timeoutMs: number;
  method: "GET" | "PUT" | "POST";
  pathname: string;
  searchParams?: Record<string, string>;
  body?: Record<string, string>;
}): Promise<ControllerClientResult> {
  const url = new URL(options.pathname, options.baseUrl);
  for (const [key, value] of Object.entries(options.searchParams ?? {})) {
    url.searchParams.set(key, value);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetcher(url, {
      method: options.method,
      headers: {
        Authorization: `Bearer ${options.secret}`,
        "Content-Type": "application/json"
      },
      body: options.body ? JSON.stringify(options.body) : undefined,
      signal: controller.signal
    });
    const body = await response.text();

    if (response.ok) {
      return { ok: true, status: response.status, body };
    }

    return {
      ok: false,
      status: response.status,
      body,
      timedOut: false,
      error: new Error(`Mihomo controller request failed with HTTP ${response.status}`)
    };
  } catch (error) {
    return {
      ok: false,
      timedOut: isAbortError(error),
      error: isAbortError(error)
        ? new Error(`Mihomo controller request timed out after ${options.timeoutMs}ms`)
        : toError(error)
    };
  } finally {
    clearTimeout(timer);
  }
}

function normalizeBaseUrl(baseUrl: string): URL {
  const parsed = new URL(baseUrl);
  if (parsed.hostname === "0.0.0.0") {
    throw new Error("Controller baseUrl must not use 0.0.0.0");
  }
  return parsed;
}

function normalizeSecret(secret: string): string {
  const normalized = secret.trim();
  if (normalized.length === 0) {
    throw new Error("Controller secret is required");
  }
  return normalized;
}

function isAbortError(error: unknown): boolean {
  return error instanceof DOMException && error.name === "AbortError";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
