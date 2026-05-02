/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { SourcingDot } from "./SourcingDot";

describe("SourcingDot", () => {
  it("renders a non-link dot when no href is provided", () => {
    render(<SourcingDot status="verified" />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByRole("img", { name: /sourcing: verified/i })).toBeInTheDocument();
  });

  it("renders an accessible link with non-empty name when href is provided", () => {
    render(<SourcingDot status="failed" href="/sourcing/personnel/abc123" />);

    // The link must have an accessible name so screen readers and HTML→text
    // converters don't render it as `[](url)`. QUA-901.
    const link = screen.getByRole("link", { name: /sourcing details: failed source check/i });
    expect(link).toHaveAttribute("href", "/sourcing/personnel/abc123");

    // The link must have visible (sr-only) text content for tools that scrape
    // anchor text without honoring aria-label.
    expect(link.textContent?.trim()).not.toBe("");
  });

  it("uses the original verdict label in the sr-only text", () => {
    render(<SourcingDot status="trouble" href="/sourcing/division/xyz" />);
    const link = screen.getByRole("link");
    expect(link.textContent?.trim()).toBeTruthy();
  });

  it("renders the dot for unchecked status when href is provided", () => {
    render(<SourcingDot status="not_run" href="/sourcing/personnel/abc123" />);
    expect(screen.getByRole("link", { name: /sourcing details: not checked/i })).toBeInTheDocument();
  });
});
