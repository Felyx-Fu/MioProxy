import { describe, expect, it } from "vitest";
import { applyYamlOverride } from "./yamlMerge.js";

describe("applyYamlOverride", () => {
  it("supports object force replace via !", () => {
    const base = { dns: { enable: true, ipv6: true } };
    const override = { "dns!": { enable: false } };

    expect(applyYamlOverride(base, override)).toEqual({ dns: { enable: false } });
  });

  it("supports array prepend and append", () => {
    const base = { rules: ["MATCH,PROXY"] };
    const override = {
      "+rules": ["DOMAIN,example.com,DIRECT"],
      "rules+": ["GEOIP,CN,DIRECT"]
    };

    expect(applyYamlOverride(base, override).rules).toEqual([
      "DOMAIN,example.com,DIRECT",
      "MATCH,PROXY",
      "GEOIP,CN,DIRECT"
    ]);
  });

  it("does not mutate the base object", () => {
    const base = { dns: { enable: true }, rules: ["MATCH,PROXY"] };
    const result = applyYamlOverride(base, { dns: { ipv6: false }, "rules+": ["FINAL,DIRECT"] });

    expect(result).not.toBe(base);
    expect(base).toEqual({ dns: { enable: true }, rules: ["MATCH,PROXY"] });
  });
});
