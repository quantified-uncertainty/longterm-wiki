// @vitest-environment jsdom
/** ProfileTabs — verifies the single-tab short-circuit path (QUA-463). */
import React from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, within } from "@testing-library/react";

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/organizations/x",
  useRouter: () => ({ replace: vi.fn(), push: vi.fn() }),
}));

import {
  ProfileTabs,
  type ProfileTab,
  type ProfileTabGroup,
} from "@components/directory/ProfileTabs";

function tab(
  id: string,
  label: string,
  content: React.ReactNode,
  count?: number,
  extras: Partial<ProfileTab> = {},
): ProfileTab {
  return { id, label, content, count, ...extras };
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

  it("treats undefined count as visible and filters explicit zeros in the multi-tab path", () => {
    render(
      <ProfileTabs
        tabs={[
          tab("a", "Overview", <div>a</div>),
          tab("b", "Funding", <div>b</div>, 0),
          tab("c", "People", <div>c</div>),
          tab("d", "Projects", <div>d</div>, 5),
        ]}
      />,
    );
    // 3 visible (a/c/d), 1 hidden (b with count=0). Must render as a tablist
    // (not the single-tab short-circuit), and the hidden tab must be absent.
    const tabEls = screen.getAllByRole("tab");
    expect(tabEls).toHaveLength(3);
    expect(tabEls.map((el) => el.textContent)).toEqual([
      "Overview",
      "People",
      "Projects5",
    ]);
  });

  describe("vertical layout + grouping", () => {
    const groups: ProfileTabGroup[] = [
      { id: "about", label: "About" },
      { id: "business", label: "Business" },
    ];

    it("renders group headers in the order specified by `groups`", () => {
      render(
        <ProfileTabs
          layout="vertical"
          groups={groups}
          tabs={[
            tab("funding", "Funding", <div>f</div>, 3, { group: "business" }),
            tab("overview", "Overview", <div>o</div>, undefined, { group: "about" }),
            tab("people", "People", <div>p</div>, 12, { group: "about" }),
          ]}
        />,
      );
      const headers = screen
        .getAllByText(/^(About|Business)$/)
        .map((el) => el.textContent);
      expect(headers).toEqual(["About", "Business"]);
    });

    it("renders icons next to labels and counts to the right", () => {
      render(
        <ProfileTabs
          layout="vertical"
          groups={groups}
          tabs={[
            tab("overview", "Overview", <div>o</div>, undefined, {
              group: "about",
              icon: <svg data-testid="overview-icon" />,
            }),
            tab("people", "People", <div>p</div>, 12, { group: "about" }),
          ]}
        />,
      );
      expect(screen.getByTestId("overview-icon")).toBeTruthy();
      // Count appears as bare number (no badge pill styling in vertical mode).
      const peopleTab = screen.getByRole("tab", { name: /People/ });
      expect(within(peopleTab).getByText("12")).toBeTruthy();
    });

    it("renders tabs without a group in a leading ungrouped bucket, no header", () => {
      render(
        <ProfileTabs
          layout="vertical"
          groups={groups}
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("people", "People", <div>p</div>, undefined, { group: "about" }),
          ]}
        />,
      );
      // Ungrouped tab should render a tab element but no preceding "__ungrouped" label.
      expect(screen.queryByText("__ungrouped")).toBeNull();
      expect(screen.getAllByRole("tab")).toHaveLength(2);
    });

    it("falls back to the group id as the label when a group referenced by a tab isn't declared", () => {
      render(
        <ProfileTabs
          layout="vertical"
          groups={[{ id: "about", label: "About" }]}
          tabs={[
            tab("overview", "Overview", <div>o</div>, undefined, { group: "about" }),
            tab("other", "Other", <div>x</div>, undefined, { group: "extra" }),
          ]}
        />,
      );
      // "extra" group wasn't declared in `groups` but should still render as a
      // fallback header using its id.
      expect(screen.getByText("extra")).toBeTruthy();
      expect(screen.getByText("About")).toBeTruthy();
    });
  });
});
