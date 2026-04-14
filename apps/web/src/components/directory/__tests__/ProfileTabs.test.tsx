// @vitest-environment jsdom
/** ProfileTabs — verifies the single-tab short-circuit path (QUA-463). */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/organizations/x",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import { ProfileTabs, type ProfileTab } from "@components/directory/ProfileTabs";

function tab(id: string, label: string, content: React.ReactNode, count?: number): ProfileTab {
  return { id, label, content, count };
}

describe("ProfileTabs", () => {
  it("renders nothing when no tabs are visible", () => {
    const { container } = render(<ProfileTabs tabs={[tab("a", "A", <div>A</div>, 0)]} />);
    expect(container.textContent).toBe("");
  });

  it("renders a single visible tab's content directly, with no tablist chrome", () => {
    // This is the giving-pledge path: 1 visible tab → skip Suspense + Tabs entirely
    // so the server/client hydration can't disagree on the single-tab fragment.
    render(
      <ProfileTabs
        tabs={[
          tab("overview", "Overview", <div data-testid="only-tab">only</div>),
          tab("funding", "Funding", <div>funding</div>, 0),
        ]}
      />,
    );
    expect(screen.getByTestId("only-tab")).toBeTruthy();
    expect(screen.queryAllByRole("tab")).toHaveLength(0);
    expect(screen.queryByRole("tablist")).toBeNull();
  });

  it("renders a tablist when two or more tabs are visible", () => {
    render(
      <ProfileTabs
        tabs={[
          tab("a", "A", <div>a content</div>),
          tab("b", "B", <div>b content</div>),
        ]}
      />,
    );
    expect(screen.getAllByRole("tab").length).toBeGreaterThanOrEqual(2);
  });

  it("treats undefined count as visible", () => {
    render(
      <ProfileTabs
        tabs={[
          tab("overview", "Overview", <div data-testid="only">o</div>),
        ]}
      />,
    );
    expect(screen.getByTestId("only")).toBeTruthy();
  });
});
