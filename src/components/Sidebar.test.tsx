import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Sidebar } from "./Sidebar";
import { I18nProvider, useI18n } from "../i18n/I18nProvider";

function LanguageTestControl() {
  const { setLanguagePreference } = useI18n();
  return (
    <div>
      <button type="button" onClick={() => setLanguagePreference("en-US")}>en-US</button>
      <button type="button" onClick={() => setLanguagePreference("zh-CN")}>zh-CN</button>
    </div>
  );
}

describe("Sidebar i18n", () => {
  it("updates visible labels, aria labels, and tooltips without remounting", () => {
    render(
      <I18nProvider>
        <LanguageTestControl />
        <Sidebar page="home" onChange={() => undefined} />
      </I18nProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "en-US" }));
    expect(screen.getByRole("complementary", { name: "Main navigation" })).toBeInTheDocument();
    const overview = screen.getByRole("button", { name: "Overview" });
    expect(overview).toHaveTextContent("Overview");
    expect(overview).toHaveAttribute("title", "Overview (Ctrl+1)");

    fireEvent.click(screen.getByRole("button", { name: "zh-CN" }));
    expect(screen.getByRole("complementary", { name: "主导航" })).toBeInTheDocument();
    const overviewZh = screen.getByRole("button", { name: "概览" });
    expect(overviewZh).toHaveTextContent("概览");
    expect(overviewZh).toHaveAttribute("title", "概览（Ctrl+1）");
    expect(screen.getByRole("button", { name: "设置" })).toHaveAttribute("title", "设置（Ctrl+,）");
  });
});
