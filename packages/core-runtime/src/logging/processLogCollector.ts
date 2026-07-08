import type { Readable } from "node:stream";
import type { CoreLogSource } from "./logEvents.js";
import { parseProcessLogLine } from "./logEvents.js";
import type { CoreLogStore } from "./logStore.js";

export interface ProcessLogCollector {
  done: Promise<void>;
  stop(): Promise<void>;
}

export interface CreateProcessLogCollectorOptions {
  profileId: string;
  store: CoreLogStore;
  stdout?: Readable;
  stderr?: Readable;
  now?: () => Date;
}

export function createProcessLogCollector(options: CreateProcessLogCollectorOptions): ProcessLogCollector {
  const now = options.now ?? (() => new Date());
  const streamCollectors = [
    options.stdout
      ? collectProcessStream({
          profileId: options.profileId,
          source: "process-stdout",
          store: options.store,
          stream: options.stdout,
          now
        })
      : undefined,
    options.stderr
      ? collectProcessStream({
          profileId: options.profileId,
          source: "process-stderr",
          store: options.store,
          stream: options.stderr,
          now
        })
      : undefined
  ].filter((collector): collector is StreamCollector => collector !== undefined);

  return {
    done: Promise.all(streamCollectors.map((collector) => collector.done)).then(() => undefined),
    async stop(): Promise<void> {
      for (const collector of streamCollectors) {
        collector.stop();
      }
      await Promise.all(streamCollectors.map((collector) => collector.done));
    }
  };
}

interface StreamCollector {
  done: Promise<void>;
  stop(): void;
}

interface CollectProcessStreamOptions {
  profileId: string;
  store: CoreLogStore;
  stream: Readable;
  source: Extract<CoreLogSource, "process-stdout" | "process-stderr">;
  now: () => Date;
}

function collectProcessStream(options: CollectProcessStreamOptions): StreamCollector {
  let buffer = "";
  let finished = false;
  let appendError: unknown;
  let queue = Promise.resolve();

  let resolveDone: () => void;
  let rejectDone: (error: unknown) => void;
  const done = new Promise<void>((resolve, reject) => {
    resolveDone = resolve;
    rejectDone = reject;
  });

  const enqueueLine = (line: string): void => {
    const event = parseProcessLogLine(line, options.source, options.now());
    if (event === null) {
      return;
    }

    queue = queue.then(async () => {
      if (appendError !== undefined) {
        return;
      }

      try {
        await options.store.append(options.profileId, event);
      } catch (error) {
        appendError = error;
      }
    });
  };

  const flush = (): void => {
    if (buffer.length > 0) {
      enqueueLine(buffer);
      buffer = "";
    }
  };

  const finish = (): void => {
    if (finished) {
      return;
    }

    finished = true;
    options.stream.off("data", onData);
    options.stream.off("end", onEnd);
    options.stream.off("error", onError);
    flush();

    void queue.then(() => {
      if (appendError !== undefined) {
        rejectDone(appendError);
        return;
      }

      resolveDone();
    });
  };

  const onData = (chunk: Buffer | string): void => {
    if (finished) {
      return;
    }

    buffer += chunkToString(chunk);

    let newlineIndex = buffer.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = buffer.slice(0, newlineIndex);
      buffer = buffer.slice(newlineIndex + 1);
      enqueueLine(line);
      newlineIndex = buffer.indexOf("\n");
    }
  };

  const onEnd = (): void => {
    finish();
  };

  const onError = (error: Error): void => {
    enqueueLine(`log stream error: ${error.message}`);
    finish();
  };

  options.stream.on("data", onData);
  options.stream.once("end", onEnd);
  options.stream.once("error", onError);

  return {
    done,
    stop: finish
  };
}

function chunkToString(chunk: Buffer | string): string {
  return typeof chunk === "string" ? chunk : chunk.toString("utf8");
}
