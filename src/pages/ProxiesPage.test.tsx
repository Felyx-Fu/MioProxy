import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CoreMode, ProxiesResponse } from "../api/mihomo";
import { I18nProvider } from "../i18n/I18nProvider";
import { proxyDelayKey } from "../utils/latency";
import { ProxiesPage } from "./ProxiesPage";

const data: ProxiesResponse = {
  groupOrder: ["Group A", "Group B", "Group C", "Group D", "GLOBAL"],
  proxies: {
    "Group A": {
      type: "Selector",
      now: "same node",
      all: ["same node", "A backup"],
      testUrl: "https://a.example.test/204",
      memberContexts: {
        "same node": { kind: "provider", provider: "provider-a", providerResolution: "resolved" },
        "A backup": { kind: "provider", provider: "provider-a", providerResolution: "resolved" },
      },
    },
    "Group B": {
      type: "URLTest",
      now: "same node",
      all: ["same node", "B backup"],
      testUrl: "https://b.example.test/204",
      memberContexts: {
        "same node": { kind: "ordinary" },
        "B backup": { kind: "ordinary" },
      },
    },
    "Group C": {
      type: "Fallback",
      now: "C backup",
      all: ["C backup"],
      memberContexts: { "C backup": { kind: "ordinary" } },
    },
    "Group D": {
      type: "LoadBalance",
      now: "D backup",
      all: ["D backup"],
      memberContexts: { "D backup": { kind: "ordinary" } },
    },
    GLOBAL: {
      type: "Selector",
      now: "same node",
      all: ["same node"],
      memberContexts: { "same node": { kind: "ordinary" } },
    },
    "same node": { type: "Vmess", "provider-name": "" },
    "A backup": { type: "Trojan" },
    "B backup": { type: "Shadowsocks" },
    "C backup": { type: "Http" },
    "D backup": { type: "Socks5" },
  },
};

const dataWithoutGlobal: ProxiesResponse = {
  proxies: Object.fromEntries(Object.entries(data.proxies).filter(([name]) => name !== "GLOBAL")),
};

function renderPage({
  onDelay = vi.fn().mockResolvedValue(undefined),
  onSelect = vi.fn().mockResolvedValue(undefined),
  onModeChange = vi.fn().mockResolvedValue(undefined),
  delayByKey = {},
  delayStatusByKey = {},
  pageData = data,
  mode = "rule",
  modeBusy = false,
}: {
  onDelay?: ReturnType<typeof vi.fn>;
  onSelect?: ReturnType<typeof vi.fn>;
  onModeChange?: ReturnType<typeof vi.fn>;
  delayByKey?: Record<string, number>;
  delayStatusByKey?: Record<string, "available" | "unavailable">;
  pageData?: ProxiesResponse;
  mode?: CoreMode | null;
  modeBusy?: boolean;
} = {}) {
  return render(
    <I18nProvider>
      <ProxiesPage
        data={pageData}
        mode={mode}
        modeBusy={modeBusy}
        loading={false}
        busyProxy={null}
        delayByKey={delayByKey}
        delayStatusByKey={delayStatusByKey}
        profilesLoaded
        profileCount={1}
        onRefresh={vi.fn()}
        onModeChange={onModeChange}
        onSelect={onSelect}
        onDelay={onDelay}
      />
    </I18nProvider>,
  );
}

function cardContaining(node: string) {
  return screen.getAllByRole("listitem").find((item) => item.textContent?.includes(node))!;
}

describe("ProxiesPage strategy center", () => {
  afterEach(() => cleanup());

  it("renders real group names in explicit groupOrder and expands only the first group by default", () => {
    renderPage();

    const headers = screen.getAllByRole("button").filter((button) => button.getAttribute("aria-controls")?.includes("proxy-group-"));
    expect(headers.map((button) => button.textContent?.match(/Group [A-D]|GLOBAL/)?.[0])).toEqual(["Group A", "Group B", "Group C", "Group D", "GLOBAL"]);
    expect(screen.getByRole("list", { name: /Group A/ })).toBeVisible();
    expect(screen.queryByRole("list", { name: /Group B/ })).not.toBeInTheDocument();
  });

  it("uses explicit groupOrder instead of proxy record enumeration order", () => {
    const pageData: ProxiesResponse = {
      groupOrder: ["Group C", "Group A", "GLOBAL", "Group D", "Group B"],
      proxies: Object.fromEntries(Object.entries(data.proxies).reverse()),
    };
    renderPage({ pageData });

    const headers = screen.getAllByRole("button").filter((button) => button.getAttribute("aria-controls")?.includes("proxy-group-"));
    expect(headers.map((button) => button.textContent?.match(/Group [A-D]|GLOBAL/)?.[0])).toEqual(["Group C", "Group A", "GLOBAL", "Group D", "Group B"]);
  });

  it("uses deterministic alphabetical ordering when groupOrder is unavailable", () => {
    const pageData: ProxiesResponse = {
      proxies: {
        Zeta: { type: "Selector", all: [] },
        Alpha: { type: "Selector", all: [] },
      },
    };
    renderPage({ pageData });

    const headers = screen.getAllByRole("button").filter((button) => button.getAttribute("aria-controls")?.includes("proxy-group-"));
    expect(headers.map((button) => button.textContent?.match(/Alpha|Zeta/)?.[0])).toEqual(["Alpha", "Zeta"]);
  });

  it("shows group type, current node, and node count in each collapsed header", () => {
    renderPage();
    const header = screen.getByRole("button", { name: /Group B/ });
    expect(header).toHaveTextContent("URLTest");
    expect(header).toHaveTextContent("same node");
    expect(header).toHaveTextContent("2");
  });

  it("collapses and expands a strategy section without changing group order", () => {
    renderPage();
    const groupA = screen.getByRole("button", { name: /Group A/ });
    fireEvent.click(groupA);
    expect(screen.queryByRole("list", { name: /Group A/ })).not.toBeInTheDocument();
    fireEvent.click(groupA);
    expect(screen.getByRole("list", { name: /Group A/ })).toBeVisible();
  });

  it("marks the runtime-selected node and selects the node through its group", () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    renderPage({ onSelect });
    const groupA = screen.getByRole("list", { name: /Group A/ });
    expect(within(groupA).getByText("Selected")).toBeInTheDocument();
    const backup = cardContaining("A backup");
    fireEvent.click(within(backup).getByRole("button", { name: /Use node/ }));
    expect(onSelect).toHaveBeenCalledWith("Group A", "A backup");
  });

  it("passes the active group context from card, toolbar, and context-menu latency actions", () => {
    const onDelay = vi.fn().mockResolvedValue(undefined);
    renderPage({ onDelay });
    const card = cardContaining("same node");

    fireEvent.click(within(card).getByRole("button", { name: /Test|测试/ }));
    fireEvent.click(screen.getByRole("button", { name: /Test selected|测试所选节点/ }));
    fireEvent.contextMenu(card);
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
    renderPage({ onDelay, delayByKey: { [proxyDelayKey(groupAContext)]: 111 } });

    fireEvent.click(screen.getByRole("button", { name: /Group B/ }));
    const groupBCard = cardContaining("B backup");
    expect(within(groupBCard).getByRole("button", { name: /Test|测试/ })).toBeInTheDocument();
    const sameNode = within(screen.getByRole("list", { name: /Group B/ })).getAllByRole("listitem").find((item) => item.textContent?.includes("same node"))!;
    fireEvent.click(within(sameNode).getByRole("button", { name: /Test|测试/ }));
    expect(onDelay).toHaveBeenCalledWith(expect.objectContaining({
      group: "Group B",
      proxy: "same node",
      testUrl: "https://b.example.test/204",
    }));
  });

  it("keeps unavailable latency state scoped to the node context", () => {
    const context = { group: "Group A", proxy: "same node", provider: "provider-a", testUrl: "https://a.example.test/204", kind: "provider" as const };
    renderPage({ delayStatusByKey: { [proxyDelayKey(context)]: "unavailable" } });
    expect(within(cardContaining("same node")).getByText("Unavailable")).toBeInTheDocument();
    expect(within(cardContaining("same node")).getByRole("button", { name: /Retry/ })).toBeInTheDocument();
  });

  it("sorts nodes by their group-scoped latency cache", () => {
    const aBackupContext = { group: "Group A", proxy: "A backup", provider: "provider-a", testUrl: "https://a.example.test/204", kind: "provider" as const };
    const sameNodeContext = { group: "Group A", proxy: "same node", provider: "provider-a", testUrl: "https://a.example.test/204", kind: "provider" as const };
    renderPage({ delayByKey: { [proxyDelayKey(aBackupContext)]: 80, [proxyDelayKey(sameNodeContext)]: 220 } });
    fireEvent.change(screen.getByRole("combobox", { name: /Sort nodes|节点排序/ }), { target: { value: "delay" } });
    const names = within(screen.getByRole("list", { name: /Group A/ })).getAllByRole("listitem").map((item) => item.querySelector("strong")?.textContent);
    expect(names).toEqual(["A backup", "same node"]);
  });

  it("filters groups and nodes, and auto-expands matching sections for presentation", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/Search groups or nodes|搜索组或节点/), { target: { value: "B backup" } });
    expect(screen.getByRole("button", { name: /Group B/ })).toBeVisible();
    expect(screen.getByRole("list", { name: /Group B/ })).toBeVisible();
    expect(screen.getByText("B backup")).toBeInTheDocument();
    expect(screen.queryByText("A backup")).not.toBeInTheDocument();
  });

  it("restores the user's collapsed state after a search is cleared", () => {
    renderPage();
    fireEvent.change(screen.getByLabelText(/Search groups or nodes|搜索组或节点/), { target: { value: "B backup" } });
    expect(screen.getByRole("list", { name: /Group B/ })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Search groups or nodes|搜索组或节点/), { target: { value: "" } });
    expect(screen.queryByRole("list", { name: /Group B/ })).not.toBeInTheDocument();
  });

  it("calls the mode change command with the selected mode and exposes contextual descriptions", () => {
    const onModeChange = vi.fn().mockResolvedValue(undefined);
    renderPage({ onModeChange });
    expect(screen.getByText("Route traffic according to the configured rules.")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: /Global/ }));
    expect(onModeChange).toHaveBeenCalledWith("global");
  });

  it("disables all mode controls and shows pending state while the authoritative switch is running", () => {
    renderPage({ mode: "rule", modeBusy: true });
    expect(screen.getByText(/Waiting for Mihomo to confirm the mode/)).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: /Rule|Global|Direct/ }).every((button) => (button as HTMLButtonElement).disabled)).toBe(true);
  });

  it("emphasizes GLOBAL only when the actual group exists and global mode is authoritative", () => {
    renderPage({ mode: "global" });
    expect(screen.getByRole("region", { name: "GLOBAL" })).toHaveAttribute("data-global-active", "true");

    cleanup();
    renderPage({ mode: "global", pageData: dataWithoutGlobal });
    expect(screen.queryByText("GLOBAL")).not.toBeInTheDocument();
  });

  it("keeps keyboard selection scoped to the expanded group", () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    renderPage({ onSelect });
    const card = cardContaining("same node");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(onSelect).toHaveBeenCalledWith("Group A", "same node");
  });
});
