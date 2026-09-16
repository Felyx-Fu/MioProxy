import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Profile } from "../api/mihomo";
import { I18nProvider } from "../i18n/I18nProvider";
import { ProfilesPage } from "./ProfilesPage";

const profile: Profile = {
  id: "profile-a",
  name: "Work routes",
  url: "https://example.com/subscription",
  filePath: "C:\\MioProxy\\profiles\\work.yaml",
  updatedAt: 1_700_000_000,
  nodeCount: 4,
};

function renderPage(overrides: Partial<React.ComponentProps<typeof ProfilesPage>> = {}) {
  const props: React.ComponentProps<typeof ProfilesPage> = {
    profiles: [], selectedId: null, appliedId: null, busyId: null, error: null,
    onSelect: vi.fn(), onAdd: vi.fn().mockResolvedValue(undefined), onDownload: vi.fn().mockResolvedValue(undefined),
    onApply: vi.fn().mockResolvedValue(undefined), onRemove: vi.fn().mockResolvedValue(undefined), onNavigate: vi.fn(),
    ...overrides,
  };
  return { ...render(<I18nProvider><ProfilesPage {...props} /></I18nProvider>), props };
}

describe("ProfilesPage subscription workflow", () => {
  afterEach(() => cleanup());

  it("submits an import once and clears the form after the save-and-download flow completes", async () => {
    const onAdd = vi.fn().mockResolvedValue(undefined);
    renderPage({ onAdd });
    fireEvent.change(screen.getByRole("textbox", { name: "Subscription URL" }), { target: { value: "https://example.com/sub" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Name (optional)" }), { target: { value: "Work" } });
    const form = screen.getByRole("button", { name: "Import" }).closest("form")!;
    fireEvent.submit(form);
    fireEvent.submit(form);
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(screen.getByRole("textbox", { name: "Subscription URL" })).toHaveValue("");
    expect(screen.getByRole("textbox", { name: "Name (optional)" })).toHaveValue("");
  });

  it("keeps entered values when saving fails so the user can retry", async () => {
    const onAdd = vi.fn().mockRejectedValue(new Error("save failed"));
    renderPage({ onAdd });
    const url = screen.getByRole("textbox", { name: "Subscription URL" });
    fireEvent.change(url, { target: { value: "https://example.com/sub" } });
    fireEvent.submit(screen.getByRole("button", { name: "Import" }).closest("form")!);
    await waitFor(() => expect(onAdd).toHaveBeenCalledTimes(1));
    expect(url).toHaveValue("https://example.com/sub");
  });

  it("does not offer activation for a profile that has not been downloaded", () => {
    renderPage({ profiles: [{ ...profile, filePath: null, nodeCount: null, updatedAt: null }] });
    expect(screen.getByRole("button", { name: "Enable" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Download" })).toBeEnabled();
  });

  it("lets the user select a profile for profile-scoped tools", () => {
    const onSelect = vi.fn();
    renderPage({ profiles: [profile, { ...profile, id: "profile-b", name: "Personal routes" }], onSelect });
    const personalCard = screen.getByRole("heading", { name: "Personal routes" }).closest("article");
    expect(personalCard).not.toBeNull();
    fireEvent.click(within(personalCard!).getByRole("button", { name: "Select" }));
    expect(onSelect).toHaveBeenCalledWith("profile-b");
  });
});
