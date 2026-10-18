import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProxiesResponse } from "../api/mihomo";
import { I18nProvider } from "../i18n/I18nProvider";
import { NodePicker } from "./NodePicker";

const data: ProxiesResponse = {
  proxies: {
    "Group A": { type: "Selector", now: "A node", all: ["A node"] },
    "Group B": { type: "Selector", now: "B node", all: ["B node"] },
  },
} as ProxiesResponse;

describe("NodePicker", () => {
  afterEach(() => cleanup());

  it("starts on the active proxy group while keeping manual group changes", () => {
    const onSelect = vi.fn().mockResolvedValue(undefined);
    render(<I18nProvider><NodePicker data={data} busy={false} activeGroup="Group B" onSelect={onSelect} /></I18nProvider>);
    const selects = screen.getAllByRole("combobox");
    expect(selects[0]).toHaveValue("Group B");

    fireEvent.change(selects[0], { target: { value: "Group A" } });
    expect(selects[0]).toHaveValue("Group A");
  });
});
