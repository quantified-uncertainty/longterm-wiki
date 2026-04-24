// @vitest-environment jsdom
/**
 * ResourceLink tests — QUA-657 regression guard.
 *
 * The not-found fallback must NEVER render the raw id in visible text.
 * Rendering `[{id}]` leaks stableIds like `sid_xxx` into user-facing pages
 * and breaks the no-raw-ids e2e test.
 */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

// Mock data-layer imports before importing the component
vi.mock("@data", () => ({
  resolveResource: vi.fn(() => undefined),
  getResourceCredibility: vi.fn(() => null),
  getResourcePublication: vi.fn(() => null),
}));

import { ResourceLink } from "@/components/wiki/ResourceLink";

describe("ResourceLink — missing resource fallback (QUA-657)", () => {
  it("renders children as fallback text when resource is not found", () => {
    render(
      <ResourceLink id="sid_missingResource">
        Scalable agent alignment via reward modeling
      </ResourceLink>,
    );
    expect(
      screen.getByText("Scalable agent alignment via reward modeling"),
    ).toBeDefined();
    expect(screen.queryByText(/sid_missingResource/)).toBeNull();
    expect(screen.queryByText(/\[sid_/)).toBeNull();
  });

  it("renders label prop as fallback when resource is not found and no children", () => {
    render(<ResourceLink id="sid_missingResource" label="Alignment Research Center" />);
    expect(screen.getByText("Alignment Research Center")).toBeDefined();
    expect(screen.queryByText(/sid_missingResource/)).toBeNull();
  });

  it("renders generic placeholder when resource missing and no children or label", () => {
    render(<ResourceLink id="sid_missingResource" />);
    expect(screen.getByText("missing resource")).toBeDefined();
    expect(screen.queryByText(/sid_missingResource/)).toBeNull();
    expect(screen.queryByText(/\[sid_/)).toBeNull();
  });

  it("preserves the full id in title attribute for dev debugging", () => {
    const { container } = render(
      <ResourceLink id="sid_missingResource">some label</ResourceLink>,
    );
    const span = container.querySelector("span[title]");
    expect(span?.getAttribute("title")).toBe("Resource not found: sid_missingResource");
  });

  it("does not leak hex-format legacy ids either", () => {
    render(
      <ResourceLink id="deadbeef1234abcd">Legacy Resource</ResourceLink>,
    );
    expect(screen.getByText("Legacy Resource")).toBeDefined();
    expect(screen.queryByText(/deadbeef1234abcd/)).toBeNull();
  });
});
