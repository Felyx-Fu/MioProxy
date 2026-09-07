import "@testing-library/jest-dom/vitest";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mihomoApi, type DnsSettings } from "../api/mihomo";
import { I18nProvider } from "../i18n/I18nProvider";
import { DnsPage } from "./DnsPage";
import { OverridesPage } from "./OverridesPage";

vi.mock("../api/mihomo", () => ({ mihomoApi: {
  dnsGet: vi.fn(), dnsSet: vi.fn(), configApply: vi.fn(),
  overrideGet: vi.fn(), overrideSet: vi.fn(), configPreview: vi.fn(),
} }));
const settings: DnsSettings = { enabled: true, enhancedMode: "fake-ip", defaultNameserver: ["1.1.1.1"], nameserver: [], fallback: [], fakeIpFilterMode: "blacklist", fakeIpFilter: [] };
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(window.navigator, "languages", "get").mockReturnValue(["en-US"]);
});
afterEach(() => { cleanup(); });
describe("configuration editors", () => {
  it("preserves DNS newlines while editing and normalizes only on save", async () => {
    vi.mocked(mihomoApi.dnsGet).mockResolvedValue(settings);
    render(<I18nProvider><DnsPage profileId="a" /></I18nProvider>);
    const input = await screen.findByDisplayValue("1.1.1.1");
    fireEvent.change(input, { target: { value: "1.1.1.1\n" } });
    expect(input).toHaveValue("1.1.1.1\n");
    fireEvent.change(input, { target: { value: "1.1.1.1\n 8.8.8.8 \n\n" } });
    fireEvent.click(screen.getByRole("button", { name: /save.*override/i }));
    await waitFor(() => expect(mihomoApi.dnsSet).toHaveBeenCalledWith({ ...settings, defaultNameserver: ["1.1.1.1", "8.8.8.8"] }));
  });
  it("blocks DNS writes before a successful load and ignores obsolete profile responses", async () => {
    const old = deferred<DnsSettings>();
    vi.mocked(mihomoApi.dnsGet).mockReturnValueOnce(old.promise).mockResolvedValueOnce({ ...settings, defaultNameserver: ["9.9.9.9"] });
    const view = render(<I18nProvider><DnsPage profileId="a" /></I18nProvider>);
    expect(screen.getByRole("button", { name: /save.*override/i })).toBeDisabled();
    view.rerender(<I18nProvider><DnsPage profileId="b" /></I18nProvider>);
    await screen.findByDisplayValue("9.9.9.9");
    await act(async () => old.resolve(settings));
    expect(screen.getByDisplayValue("9.9.9.9")).toBeInTheDocument();
    expect(mihomoApi.dnsSet).not.toHaveBeenCalled();
  });
  it("keeps DNS writes blocked after loading fails", async () => {
    vi.mocked(mihomoApi.dnsGet).mockRejectedValue(new Error("read failed"));
    render(<I18nProvider><DnsPage profileId="a" /></I18nProvider>);
    await screen.findByRole("alert");
    expect(screen.getByRole("button", { name: /save.*override/i })).toBeDisabled();
  });
  it("blocks overwrite of the override file while its initial read is pending", async () => {
    const pending = deferred<Awaited<ReturnType<typeof mihomoApi.overrideGet>>>();
    vi.mocked(mihomoApi.overrideGet).mockReturnValue(pending.promise);
    render(<I18nProvider><OverridesPage profileId="a" /></I18nProvider>);
    expect(screen.getByRole("button", { name: /save.*override/i })).toBeDisabled();
    expect(screen.getByRole("textbox")).toBeDisabled();
    await act(async () => pending.resolve({ content: "mode: rule" } as Awaited<ReturnType<typeof mihomoApi.overrideGet>>));
    await waitFor(() => expect(screen.getByRole("textbox")).toBeEnabled());
    expect(screen.getByRole("textbox")).toHaveValue("mode: rule");
    expect(mihomoApi.overrideSet).not.toHaveBeenCalled();
  });
});

