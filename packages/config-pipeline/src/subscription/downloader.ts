export interface SubscriptionCache {
  read(profileId: string): Promise<string | null>;
  write(profileId: string, contents: string): Promise<void>;
}

export interface SubscriptionDownloadOptions {
  profileId: string;
  url: string;
  headers?: Record<string, string>;
  timeoutMs?: number;
  retries?: number;
  cache: SubscriptionCache;
  fetcher?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type SubscriptionDownloadResult =
  | { ok: true; source: "network" | "cache"; contents: string; attempts: number }
  | { ok: false; error: Error; attempts: number };

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_RETRIES = 3;

export async function downloadSubscription(
  options: SubscriptionDownloadOptions
): Promise<SubscriptionDownloadResult> {
  const fetcher = options.fetcher ?? fetch;
  const sleep = options.sleep ?? defaultSleep;
  const retries = options.retries ?? DEFAULT_RETRIES;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= retries; attempt += 1) {
    try {
      const contents = await fetchSubscriptionText({
        url: options.url,
        headers: options.headers,
        timeoutMs,
        fetcher
      });

      if (contents.trim().length === 0) {
        throw new Error("Subscription response is empty");
      }

      await options.cache.write(options.profileId, contents);
      return { ok: true, source: "network", contents, attempts: attempt };
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));

      if (attempt < retries) {
        await sleep(backoffMs(attempt));
      }
    }
  }

  const cached = await options.cache.read(options.profileId);
  if (cached !== null && cached.trim().length > 0) {
    return { ok: true, source: "cache", contents: cached, attempts: retries };
  }

  return {
    ok: false,
    error: lastError ?? new Error("Subscription download failed"),
    attempts: retries
  };
}

async function fetchSubscriptionText(options: {
  url: string;
  headers?: Record<string, string>;
  timeoutMs: number;
  fetcher: typeof fetch;
}): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);

  try {
    const response = await options.fetcher(options.url, {
      method: "GET",
      headers: options.headers,
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Subscription request failed with HTTP ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

function backoffMs(attempt: number): number {
  return Math.min(1_000 * 2 ** (attempt - 1), 5_000);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
