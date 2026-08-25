import { describe, expect, it } from "vitest";
import { classifyNodeRegion } from "./nodeRegion";

describe("node region classification", () => {
  it("recognizes explicit region names and codes", () => {
    expect(classifyNodeRegion("HK-01").id).toBe("hk");
    expect(classifyNodeRegion("香港 IEPL").id).toBe("hk");
    expect(classifyNodeRegion("🇭🇰 Premium").id).toBe("hk");
    expect(classifyNodeRegion("SG-01").id).toBe("sg");
    expect(classifyNodeRegion("新加坡 01").id).toBe("sg");
    expect(classifyNodeRegion("JP-01").id).toBe("jp");
    expect(classifyNodeRegion("日本 01").id).toBe("jp");
    expect(classifyNodeRegion("US-01").id).toBe("us");
    expect(classifyNodeRegion("Australia").id).toBe("au");
    expect(classifyNodeRegion("印度尼西亚 01").id).toBe("id");
  });

  it("gives an explicit flag priority over weaker tokens", () => {
    expect(classifyNodeRegion("🇭🇰 SG-01 US").id).toBe("hk");
  });

  it("requires short Latin codes to be separated from words", () => {
    expect(classifyNodeRegion("Status").id).toBe("unknown");
    expect(classifyNodeRegion("Premium").id).toBe("unknown");
    expect(classifyNodeRegion("Singapore").id).toBe("sg");
    expect(classifyNodeRegion("IN-01").id).toBe("in");
    expect(classifyNodeRegion("TH 02").id).toBe("th");
  });

  it("does not infer regions from city names or built-in nodes", () => {
    expect(classifyNodeRegion("Tokyo").id).toBe("unknown");
    expect(classifyNodeRegion("Los Angeles").id).toBe("unknown");
    expect(classifyNodeRegion("DIRECT").id).toBe("unknown");
    expect(classifyNodeRegion("REJECT-DROP").id).toBe("unknown");
  });
});

