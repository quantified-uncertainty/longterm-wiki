/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { UncheckedSourcingState } from "./UncheckedSourcingState";

describe("UncheckedSourcingState", () => {
  it("renders record name, type pill, and unchecked message", () => {
    render(
      <UncheckedSourcingState
        recordType="wiki-page"
        recordId="page:anthropic:overview"
        displayName="Anthropic Overview"
        recordHref="/wiki/anthropic"
      />
    );

    expect(screen.getByText("Anthropic Overview")).toBeInTheDocument();
    expect(screen.getByText("page:anthropic:overview")).toBeInTheDocument();
    expect(screen.getByText(/Not yet sourced/i)).toBeInTheDocument();
    expect(screen.getByText(/has not been run through the sourcing pipeline/i)).toBeInTheDocument();
  });

  it("renders View the record link when recordHref is provided", () => {
    render(
      <UncheckedSourcingState
        recordType="grant"
        recordId="g_abc123"
        displayName="AI Safety Grant"
        recordHref="/grants/g_abc123"
      />
    );

    const link = screen.getByRole("link", { name: /view the record/i });
    expect(link).toHaveAttribute("href", "/grants/g_abc123");
  });

  it("omits View the record link when recordHref is null", () => {
    render(
      <UncheckedSourcingState
        recordType="investment"
        recordId="inv_xyz"
        displayName="Test Investment"
        recordHref={null}
      />
    );

    expect(screen.queryByRole("link", { name: /view the record/i })).toBeNull();
  });

  it("always renders the All Source Checks back link", () => {
    render(
      <UncheckedSourcingState
        recordType="grant"
        recordId="g1"
        displayName="x"
        recordHref={null}
      />
    );

    const back = screen.getByRole("link", { name: /all source checks/i });
    expect(back).toHaveAttribute("href", "/sourcing");
  });
});
