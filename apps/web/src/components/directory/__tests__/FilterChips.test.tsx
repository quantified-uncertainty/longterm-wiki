// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { FilterChips } from "../FilterChips";

function renderChips(props: Partial<React.ComponentProps<typeof FilterChips>> = {}) {
  const onSelect = vi.fn();
  const utils = render(
    <FilterChips
      items={[
        { key: "enacted", label: "enacted", count: 18 },
        { key: "vetoed", label: "vetoed", count: 1 },
      ]}
      selected="all"
      onSelect={onSelect}
      allCount={19}
      {...props}
    />,
  );
  return { ...utils, onSelect };
}

describe("FilterChips", () => {
  it("renders 'Label (count)' with a real space in textContent (closes QUA-918)", () => {
    renderChips();
    const enactedChip = screen.getByRole("button", { name: /enacted/i });
    // The fix: real space + parentheses so textContent isn't 'enacted18'.
    expect(enactedChip.textContent).toBe("enacted (18)");
    expect(enactedChip.textContent).not.toBe("enacted18");
  });

  it("renders the All chip with its count formatted the same way", () => {
    renderChips();
    const allChip = screen.getByRole("button", { name: /all/i });
    expect(allChip.textContent).toBe("All (19)");
  });

  it("aria-label uses the same 'Label (count)' format", () => {
    renderChips();
    expect(
      screen.getByRole("button", { name: "enacted (18)" }),
    ).toBeDefined();
  });

  it("calls onSelect with the chip key when clicked", () => {
    const { onSelect } = renderChips();
    fireEvent.click(screen.getByRole("button", { name: /enacted/i }));
    expect(onSelect).toHaveBeenCalledWith("enacted");
  });

  it("clicking the currently-selected chip resets to 'all'", () => {
    const { onSelect } = renderChips({ selected: "enacted" });
    fireEvent.click(screen.getByRole("button", { name: /enacted/i }));
    expect(onSelect).toHaveBeenCalledWith("all");
  });

  it("clicking the All chip selects 'all'", () => {
    const { onSelect } = renderChips({ selected: "enacted" });
    fireEvent.click(screen.getByRole("button", { name: /all/i }));
    expect(onSelect).toHaveBeenCalledWith("all");
  });

  it("aria-pressed reflects the selected key", () => {
    renderChips({ selected: "enacted" });
    expect(
      screen.getByRole("button", { name: /enacted/i }).getAttribute("aria-pressed"),
    ).toBe("true");
    expect(
      screen.getByRole("button", { name: /vetoed/i }).getAttribute("aria-pressed"),
    ).toBe("false");
  });

  it("renders a prefix label when provided", () => {
    renderChips({ prefix: "Status:" });
    expect(screen.getByText("Status:")).toBeDefined();
  });

  it("hides chips with count === 0", () => {
    renderChips({
      items: [
        { key: "enacted", label: "enacted", count: 18 },
        { key: "phantom", label: "phantom", count: 0 },
      ],
    });
    expect(screen.queryByRole("button", { name: /phantom/i })).toBeNull();
  });

  it("hides tautology facets when hideTautologyFacets is set", () => {
    renderChips({
      items: [
        { key: "active", label: "Active", count: 50 },
        { key: "emerging", label: "Emerging", count: 5 },
      ],
      allCount: 50,
      hideTautologyFacets: true,
    });
    // Active === total, should be hidden (closes QUA-919 tautology arm).
    expect(screen.queryByRole("button", { name: /^Active/i })).toBeNull();
    expect(screen.getByRole("button", { name: /emerging/i })).toBeDefined();
  });

  it("renders nothing when hideWhenTrivial leaves zero or one chips", () => {
    const { container } = render(
      <FilterChips
        items={[{ key: "active", label: "Active", count: 50 }]}
        selected="all"
        onSelect={vi.fn()}
        allCount={50}
        hideTautologyFacets
        hideWhenTrivial
      />,
    );
    expect(container.textContent).toBe("");
  });

  it("renders without count when chip has no count field", () => {
    renderChips({
      items: [{ key: "all-time", label: "All time" }],
      allCount: undefined,
    });
    const chip = screen.getByRole("button", { name: "All time" });
    expect(chip.textContent).toBe("All time");
  });

  it("handles labels with internal spaces correctly (closes QUA-918 'Convertible Note3' case)", () => {
    renderChips({
      items: [{ key: "convertible-note", label: "Convertible Note", count: 3 }],
    });
    const chip = screen.getByRole("button", { name: /Convertible Note/i });
    expect(chip.textContent).toBe("Convertible Note (3)");
  });
});
