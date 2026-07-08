import { describe, expect, it } from "vitest";
import { runJsOverride } from "./jsRunner.js";

describe("runJsOverride", () => {
  it("runs main(config) and returns the transformed object", () => {
    const result = runJsOverride({
      config: { rules: ["MATCH,PROXY"] },
      script: `
        function main(config) {
          config.rules.unshift("DOMAIN,example.com,DIRECT");
          return config;
        }
      `
    });

    expect(result.rules).toEqual(["DOMAIN,example.com,DIRECT", "MATCH,PROXY"]);
  });

  it("does not mutate the caller config object", () => {
    const input = { rules: ["MATCH,PROXY"] };
    runJsOverride({
      config: input,
      script: `
        function main(config) {
          config.rules.push("FINAL,DIRECT");
          return config;
        }
      `
    });

    expect(input).toEqual({ rules: ["MATCH,PROXY"] });
  });

  it("rejects scripts that do not return an object", () => {
    expect(() =>
      runJsOverride({
        config: {},
        script: `
          function main(config) {
            return null;
          }
        `
      })
    ).toThrow("must return an object");
  });

  it("times out long-running scripts", () => {
    expect(() =>
      runJsOverride({
        config: {},
        timeoutMs: 20,
        script: `
          function main(config) {
            while (true) {}
          }
        `
      })
    ).toThrow();
  });
});
