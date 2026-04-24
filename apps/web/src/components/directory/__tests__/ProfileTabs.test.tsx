// @vitest-environment jsdom
/** ProfileTabs — single-tab short-circuit (QUA-463) and URL-sync (QUA-668). */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

// Per-test mutable state so we can drive the mocked router/searchParams.
const mockState = {
  search: "",
  replace: vi.fn() as ReturnType<typeof vi.fn>,
};

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockState.search),
  usePathname: () => "/organizations/x",
  useRouter: () => ({ replace: mockState.replace, push: vi.fn() }),
}));

import {
  ProfileTabs,
  type ProfileTab,
  type ProfileTabGroup,
} from "@components/directory/ProfileTabs";

beforeEach(() => {
  mockState.search = "";
  mockState.replace = vi.fn();
});

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

  describe("URL sync + scroll preservation (QUA-668)", () => {
    function clickTab(el: HTMLElement) {
      // Radix Tabs listens for mouseDown (pointer events) on the trigger; jsdom
      // + fireEvent.click alone doesn't always route through Radix's handler.
      fireEvent.mouseDown(el);
      fireEvent.click(el);
    }

    it("calls router.replace with scroll:false when a non-default tab is clicked", () => {
      render(
        <ProfileTabs
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      clickTab(screen.getByRole("tab", { name: /Facts/ }));
      expect(mockState.replace).toHaveBeenCalledWith(
        "/organizations/x?tab=facts",
        { scroll: false },
      );
    });

    it("strips ?tab= from URL when the default tab is clicked", () => {
      mockState.search = "tab=facts";
      render(
        <ProfileTabs
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      clickTab(screen.getByRole("tab", { name: /Overview/ }));
      expect(mockState.replace).toHaveBeenCalledWith("/organizations/x", {
        scroll: false,
      });
    });

    it("shows a banner and falls back to the default tab when ?tab= names an unknown tab", () => {
      mockState.search = "tab=shareholders";
      render(
        <ProfileTabs
          tabs={[
            tab("overview", "Overview", <div data-testid="overview-content">o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      // Banner names the requested tab + the fallback target.
      const banner = screen.getByRole("status");
      expect(banner.textContent).toMatch(/shareholders/);
      expect(banner.textContent).toMatch(/Overview/);
      // Default tab's content is shown.
      expect(screen.getByTestId("overview-content")).toBeTruthy();
    });

    it("does NOT show the banner when ?tab= matches a known tab", () => {
      mockState.search = "tab=facts";
      render(
        <ProfileTabs
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      expect(screen.queryByRole("status")).toBeNull();
    });
  });

  describe("QUA-656: hydration safety", () => {
    // SSR path: the server renders the component without access to URL search
    // params; the initial render on BOTH server and client must pick the first
    // selectable tab so the two trees match exactly. URL-based selection is
    // applied via useEffect after hydration.
    it("first visible tab is a link — default is the first non-link tab", () => {
      render(
        <ProfileTabs
          tabs={[
            tab("wiki", "Wiki", null, undefined, { href: "/wiki/E1" }),
            tab("overview", "Overview", <div data-testid="overview">o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      // Overview content renders (it's the first non-link tab = default).
      expect(screen.getByTestId("overview")).toBeTruthy();
    });

    it("post-hydration effect activates a known ?tab= param", () => {
      mockState.search = "tab=facts";
      render(
        <ProfileTabs
          tabs={[
            tab("overview", "Overview", <div>overview</div>),
            tab("facts", "Facts", <div data-testid="facts-content">facts</div>),
          ]}
        />,
      );
      // jsdom runs effects synchronously on render, so by the time this
      // assertion runs the useEffect has applied the URL param and Facts is
      // active.
      const activeTab = screen.getByRole("tab", { selected: true });
      expect(activeTab.textContent).toMatch(/Facts/);
      // Active panel is Facts'.
      expect(screen.getByTestId("facts-content")).toBeTruthy();
    });
  });
});
