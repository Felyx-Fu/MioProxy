import { describe, expect, it } from "vitest";
import { sanitizeMihomoConfig } from "./mihomoCompat.js";

describe("sanitizeMihomoConfig", () => {
  it("removes deprecated global-client-fingerprint", () => {
    const result = sanitizeMihomoConfig({
      "global-client-fingerprint": "chrome",
      proxies: [{ name: "a", type: "trojan" }]
    });

    expect(result.config["global-client-fingerprint"]).toBeUndefined();
    expect(result.warnings.map((warning) => warning.code)).toContain(
      "deprecated.global-client-fingerprint"
    );
  });

  it("downgrades smart groups to url-test when members exist", () => {
    const result = sanitizeMihomoConfig({
      "proxy-groups": [{ name: "Smart Group", type: "smart", proxies: ["A", "B"] }]
    });

    expect(result.config["proxy-groups"]?.[0]?.type).toBe("url-test");
    expect(result.config["proxy-groups"]?.[0]?.url).toBe("https://www.gstatic.com/generate_204");
  });

  it("removes group-level fields that Mihomo rejects", () => {
    const result = sanitizeMihomoConfig({
      "proxy-groups": [
        {
          name: "Auto",
          type: "url-test",
          proxies: ["A"],
          "routing-mark": 1,
          "interface-name": "eth0"
        }
      ]
    });

    expect(result.config["proxy-groups"]?.[0]?.["routing-mark"]).toBeUndefined();
    expect(result.config["proxy-groups"]?.[0]?.["interface-name"]).toBeUndefined();
  });
});
