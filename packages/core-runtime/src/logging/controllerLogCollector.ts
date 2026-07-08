import { parseControllerLogMessage } from "./logEvents.js";
import type { CoreLogStore } from "./logStore.js";

export interface ControllerLogCollector {
  done: Promise<void>;
  stop(): Promise<void>;
}

export interface CreateControllerLogCollectorOptions {
  profileId: string;
  baseUrl: string;
  secret: string;
  store: CoreLogStore;
  level?: "debug" | "info" | "warning" | "error";
  fetcher?: typeof fetch;
}

export function createControllerLogCollector(
  options: CreateControllerLogCollectorOptions
): ControllerLogCollector {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const secret = normalizeSecret(options.secret);
  const fetcher = options.fetcher ?? fetch;
  const abortController = new AbortController();
  const done = collectControllerLogs({
    profileId: options.profileId,
    url: logsUrl(baseUrl, options.level),
    secret,
    store: options.store,
    fetcher,
    signal: abortController.signal
  });

  return {
    done,
    async stop(): Promise<void> {
      abortController.abort();
      await done.catch((error) => {
        if (!isAbortError(error)) {
          throw error;
        }
      });
    }
  };
}

async function collectControllerLogs(options: {
  profileId: string;
  url: URL;
  secret: string;
  store: CoreLogStore;
  fetcher: typeof fetch;
  signal: AbortSignal;
}): Promise<void> {
  const response = await options.fetcher(options.url, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${options.secret}`
    },
    signal: options.signal
  });

  if (!response.ok) {
    throw new Error(`Mihomo controller logs request failed with HTTP ${response.status}`);
  }
  if (!response.body) {
    return;
  }

  await readTextStreamLines(response.body, async (line) => {
    const event = parseControllerLogMessage(line);
    if (event) {
      await options.store.append(options.profileId, event);
    }
  });
}

async function readTextStreamLines(
  body: ReadableStream<Uint8Array>,
  onLine: (line: string) => Promise<void>
): Promise<void> {
  const decoder = new TextDecoder();
  const reader = body.getReader();
  let buffer = "";

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) {
        break;
      }

      buffer += decoder.decode(chunk.value, { stream: true });
      let newlineIndex = buffer.indexOf("\n");
      while (newlineIndex !== -1) {
        const line = buffer.slice(0, newlineIndex).replace(/\r$/, "");
        buffer = buffer.slice(newlineIndex + 1);
        await onLine(line);
        newlineIndex = buffer.indexOf("\n");
      }
    }
  } finally {
    reader.releaseLock();
  }

  buffer += decoder.decode();
  if (buffer.length > 0) {
    await onLine(buffer);
  }
}

function logsUrl(baseUrl: URL, level: string | undefined): URL {
  const url = new URL("/logs", baseUrl);
  url.searchParams.set("format", "structured");
  if (level) {
    url.searchParams.set("level", level);
  }
  return url;
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
