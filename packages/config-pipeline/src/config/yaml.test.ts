import { describe, expect, it } from "vitest";
import { parseYamlToObject, stringifyStableYaml } from "./yaml.js";

describe("yaml helpers", () => {
  it("parses object roots", () => {
    expect(parseYamlToObject("mixed-port: 7890\n")).toEqual({ "mixed-port": 7890 });
  });

  it("rejects non-object roots", () => {
    expect(() => parseYamlToObject("- a\n- b\n")).toThrow("YAML root must be an object");
  });

  it("sorts object keys for stable output", () => {
    expect(stringifyStableYaml({ z: 1, a: { c: 3, b: 2 } })).toBe("a:\n  b: 2\n  c: 3\nz: 1\n");
  });
});
