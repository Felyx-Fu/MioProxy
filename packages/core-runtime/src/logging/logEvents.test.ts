import { describe, expect, it } from "vitest";
import {
  parseControllerLogMessage,
  parseProcessLogLine,
  serializeLogEvent
} from "./logEvents.js";

describe("log event parsing", () => {
  it("parses process stdout lines", () => {
    expect(parseProcessLogLine("[INFO] started", "process-stdout", new Date("2026-07-07T10:00:00.000Z"))).toEqual({
      time: "2026-07-07T10:00:00.000Z",
      source: "process-stdout",
      level: "info",
      message: "[INFO] started"
    });
  });

  it("ignores empty process lines", () => {
    expect(parseProcessLogLine("   ", "process-stderr")).toBeNull();
  });

  it("parses structured controller log messages", () => {
    expect(
      parseControllerLogMessage(
        JSON.stringify({
          time: "2026-07-07T10:00:00.000Z",
          level: "warning",
          message: "deprecated field",
          fields: { key: "global-client-fingerprint" }
        })
      )
    ).toEqual({
      time: "2026-07-07T10:00:00.000Z",
      source: "controller-logs",
      level: "warning",
      message: "deprecated field",
      fields: { key: "global-client-fingerprint" }
    });
  });

  it("parses standard mihomo controller log messages", () => {
    expect(
      parseControllerLogMessage(
        JSON.stringify({
          type: "debug",
          payload: "rule matched"
        })
      )
    ).toMatchObject({
      source: "controller-logs",
      level: "debug",
      message: "rule matched"
    });
  });

  it("keeps structured controller log fields arrays", () => {
    expect(
      parseControllerLogMessage(
        JSON.stringify({
          time: "10:00:00",
          level: "info",
          message: "dns query",
          fields: ["example.test", "A"]
        })
      )
    ).toEqual({
      time: "10:00:00",
      source: "controller-logs",
      level: "info",
      message: "dns query",
      fields: { items: ["example.test", "A"] }
    });
  });

  it("falls back to plain text controller messages", () => {
    const event = parseControllerLogMessage("panic: lightgbm");
    expect(event?.source).toBe("controller-logs");
    expect(event?.level).toBe("error");
    expect(event?.message).toBe("panic: lightgbm");
  });

  it("serializes events as json lines", () => {
    expect(
      serializeLogEvent({
        time: "2026-07-07T10:00:00.000Z",
        source: "process-stderr",
        level: "error",
        message: "failed"
      })
    ).toBe(
      '{"time":"2026-07-07T10:00:00.000Z","source":"process-stderr","level":"error","message":"failed"}'
    );
  });
});
