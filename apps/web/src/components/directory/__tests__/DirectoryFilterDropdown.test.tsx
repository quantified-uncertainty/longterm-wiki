// @vitest-environment jsdom
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { DirectoryFilterDropdown } from "../DirectoryFilterDropdown";

function renderDropdown(
  props: Partial<React.ComponentProps<typeof DirectoryFilterDropdown>> = {},
) {
  const onSelect = vi.fn();
  const utils = render(
    <DirectoryFilterDropdown
      ariaLabel="Filter by funder"
      items={[
        { key: "open-phil", label: "Open Philanthropy", count: 42 },
        { key: "ftx", label: "FTX Future Fund", count: 5 },
      ]}
      selected="all"
      onSelect={onSelect}
      allCount={47}
      {...props}
    />,
  );
  return { ...utils, onSelect };
}

describe("DirectoryFilterDropdown", () => {
  it("formats option labels as 'Label (count)' with a real space (closes QUA-918)", () => {
    renderDropdown();
    const select = screen.getByLabelText(
      "Filter by funder",
    ) as HTMLSelectElement;
    const options = Array.from(select.options).map((o) => o.textContent);
    expect(options).toEqual([
      "All (47)",
      "Open Philanthropy (42)",
      "FTX Future Fund (5)",
    ]);
    // Specifically: no concatenated 'OpenPhilanthropy42' shape.
    for (const t of options) {
      expect(t).toMatch(/\)$/);
    }
  });

  it("calls onSelect with the chosen value", () => {
    const { onSelect } = renderDropdown();
    const select = screen.getByLabelText(
      "Filter by funder",
    ) as HTMLSelectElement;
    fireEvent.change(select, { target: { value: "ftx" } });
    expect(onSelect).toHaveBeenCalledWith("ftx");
  });

  it("uses the selected prop as the controlled value", () => {
    renderDropdown({ selected: "open-phil" });
    const select = screen.getByLabelText(
      "Filter by funder",
    ) as HTMLSelectElement;
    expect(select.value).toBe("open-phil");
  });

  it("hides options with count === 0", () => {
    renderDropdown({
      items: [
        { key: "open-phil", label: "Open Philanthropy", count: 42 },
        { key: "phantom", label: "Phantom", count: 0 },
      ],
    });
    const options = Array.from(
      (screen.getByLabelText("Filter by funder") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).not.toContain("phantom");
  });

  it("hides tautology options when hideTautologyFacets is set", () => {
    renderDropdown({
      items: [
        { key: "active", label: "Active", count: 50 },
        { key: "emerging", label: "Emerging", count: 5 },
      ],
      allCount: 50,
      hideTautologyFacets: true,
    });
    const options = Array.from(
      (screen.getByLabelText("Filter by funder") as HTMLSelectElement).options,
    ).map((o) => o.value);
    expect(options).not.toContain("active");
    expect(options).toContain("emerging");
  });

  it("renders nothing when hideWhenTrivial leaves zero or one items", () => {
    const { container } = render(
      <DirectoryFilterDropdown
        ariaLabel="x"
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

  it("renders a prefix label when provided", () => {
    renderDropdown({ prefix: "Funder:" });
    expect(screen.getByText("Funder:")).toBeDefined();
  });
});
