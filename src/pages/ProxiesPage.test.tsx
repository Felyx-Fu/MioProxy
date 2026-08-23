import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxiesResponse } from "../api/mihomo";
import { I18nProvider } from "../i18n/I18nProvider";
import { proxyDelayKey } from "../utils/latency";
import { ProxiesPage } from "./ProxiesPage";

const data: ProxiesResponse = {
  proxies: {
    "Group A": {
      type: "Selector",
      now: "same node",
      all: ["same node"],
      testUrl: "https://a.example.test/204",
      memberContexts: {
        "same node": { kind: "provider", provider: "provider-a", providerResolution: "resolved" },
      },
    },
    "Group B": {
      type: "URLTest",
      now: "same node",
      all: ["same node"],
      testUrl: "https://b.example.test/204",
      memberContexts: {
        "same node": { kind: "ordinary" },
      },
    },
    "same node": { type: "Vmess", "provider-name": "" },
  },
};

function renderPage(onDelay = vi.fn().mockResolvedValue(undefined), delayByKey: Record<string, number> = {}) {
  return render(
    <I18nProvider>
      <ProxiesPage
        data={data}
        loading={false}
        busyProxy={null}
        delayByKey={delayByKey}
        delayStatusByKey={{}}
        profilesLoaded
        profileCount={1}
        onRefresh={vi.fn()}
        onSelect={vi.fn().mockResolvedValue(undefined)}
        onDelay={onDelay}
      />
    </I18nProvider>,
  );
}

describe("ProxiesPage latency context", () => {
  afterEach(() => cleanup());

  it("passes the active group context from row, toolbar, and context-menu latency actions", () => {
    const onDelay = vi.fn().mockResolvedValue(undefined);
    renderPage(onDelay);
    const row = screen.getByRole("row", { name: /same node/ });

    fireEvent.click(within(row).getByRole("button"));
    fireEvent.click(screen.getByRole("button", { name: /Test selected|测试所选节点/ }));
    fireEvent.contextMenu(row);
    fireEvent.click(screen.getByRole("menuitem", { name: /Test latency|测试延迟/ }));

    expect(onDelay).toHaveBeenCalledTimes(3);
    for (const call of onDelay.mock.calls) {
      expect(call[0]).toMatchObject({
        group: "Group A",
        proxy: "same node",
        provider: "provider-a",
        testUrl: "https://a.example.test/204",
        kind: "provider",
      });
    }
  });

  it("uses a different latency cache entry when the same node is in another group", () => {
    const groupAContext = {
      group: "Group A",
      proxy: "same node",
      provider: "provider-a",
      testUrl: "https://a.example.test/204",
      kind: "provider" as const,
    };
    const onDelay = vi.fn().mockResolvedValue(undefined);
    renderPage(onDelay, { [proxyDelayKey(groupAContext)]: 111 });

    fireEvent.click(screen.getByRole("button", { name: /Group B/ }));
    const groupBRow = screen.getByRole("row", { name: /same node/ });
    expect(within(groupBRow).getByRole("button")).toHaveTextContent(/Test|测试/);

    fireEvent.click(within(groupBRow).getByRole("button"));
    expect(onDelay).toHaveBeenCalledWith(expect.objectContaining({
      group: "Group B",
      proxy: "same node",
      testUrl: "https://b.example.test/204",
    }));
  });
});
