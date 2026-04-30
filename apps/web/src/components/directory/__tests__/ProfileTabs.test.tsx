// @vitest-environment jsdom
/** ProfileTabs — single-tab short-circuit (QUA-463) and URL-sync (QUA-668). */
import React from "react";
import { describe, expect, it, vi, beforeEach } from "vitest";
import { render, screen, within, fireEvent } from "@testing-library/react";

// Per-test mutable state so we can drive the mocked router/searchParams.
const mockState = {
  search: "",
  pathname: "/organizations/x",
  replace: vi.fn() as ReturnType<typeof vi.fn>,
};

vi.mock("next/navigation", () => ({
  useSearchParams: () => new URLSearchParams(mockState.search),
  usePathname: () => mockState.pathname,
  useRouter: () => ({ replace: mockState.replace, push: vi.fn() }),
}));

import {
  ProfileTabs,
  type ProfileTab,
  type ProfileTabGroup,
} from "@components/directory/ProfileTabs";

beforeEach(() => {
  mockState.search = "";
  mockState.pathname = "/organizations/x";
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

  describe("path-mode routing (QUA-877)", () => {
    const basePath = "/organizations/anthropic";

    it("derives default tab when pathname equals basePath (no segment)", () => {
      mockState.pathname = basePath;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div data-testid="overview-content">o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      const activeTab = screen.getByRole("tab", { selected: true });
      expect(activeTab.textContent).toMatch(/Overview/);
      expect(screen.getByTestId("overview-content")).toBeTruthy();
    });

    it("derives active tab from a known segment in the pathname", () => {
      mockState.pathname = `${basePath}/facts`;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("facts", "Facts", <div data-testid="facts-content">f</div>),
          ]}
        />,
      );
      const activeTab = screen.getByRole("tab", { selected: true });
      expect(activeTab.textContent).toMatch(/Facts/);
      expect(screen.getByTestId("facts-content")).toBeTruthy();
    });

    it("falls back to default tab + shows notice when segment is unknown", () => {
      mockState.pathname = `${basePath}/shareholders`;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div data-testid="overview-content">o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      // Banner names the requested unknown segment + the fallback target.
      const banner = screen.getByRole("status");
      expect(banner.textContent).toMatch(/shareholders/);
      expect(banner.textContent).toMatch(/Overview/);
      // Default tab is active and its content renders.
      expect(screen.getByTestId("overview-content")).toBeTruthy();
    });

    it("renders tab triggers as <a> Links with the expected hrefs", () => {
      mockState.pathname = basePath;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("facts", "Facts", <div>f</div>),
            tab("people", "People", <div>p</div>),
          ]}
        />,
      );
      const triggers = screen.getAllByRole("tab");
      expect(triggers).toHaveLength(3);
      // Default tab → bare basePath (no segment).
      expect(triggers[0].tagName).toBe("A");
      expect(triggers[0].getAttribute("href")).toBe(basePath);
      // Non-default tabs → ${basePath}/${id}.
      expect(triggers[1].getAttribute("href")).toBe(`${basePath}/facts`);
      expect(triggers[2].getAttribute("href")).toBe(`${basePath}/people`);
    });

    it("active state on the Link trigger matches the pathname segment", () => {
      mockState.pathname = `${basePath}/people`;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("facts", "Facts", <div>f</div>),
            tab("people", "People", <div>p</div>),
          ]}
        />,
      );
      const triggers = screen.getAllByRole("tab");
      // Only the matching segment's trigger is data-state="active".
      const states = triggers.map((t) => t.getAttribute("data-state"));
      expect(states).toEqual(["inactive", "inactive", "active"]);
    });

    it("normalizes basePath with a trailing slash", () => {
      mockState.pathname = "/organizations/anthropic";
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath: "/organizations/anthropic/" }}
          tabs={[
            tab("overview", "Overview", <div data-testid="overview-content">o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      // Default tab is active without double-slash in the href either.
      expect(screen.getByTestId("overview-content")).toBeTruthy();
      const triggers = screen.getAllByRole("tab");
      expect(triggers[0].getAttribute("href")).toBe("/organizations/anthropic");
      expect(triggers[1].getAttribute("href")).toBe("/organizations/anthropic/facts");
    });

    it("treats trailing slash on pathname as bare basePath", () => {
      mockState.pathname = `${basePath}/`;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div data-testid="overview-content">o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      expect(screen.getByTestId("overview-content")).toBeTruthy();
    });

    it("does not call router.replace in path mode (Link drives navigation)", () => {
      mockState.pathname = basePath;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      // Click would normally fire navigation; the Link itself handles it via
      // next/navigation, not via router.replace.
      fireEvent.click(screen.getByRole("tab", { name: /Facts/ }));
      expect(mockState.replace).not.toHaveBeenCalled();
    });

    it("preserves explicit tab.href in path mode (vertical link-tabs)", () => {
      mockState.pathname = basePath;
      render(
        <ProfileTabs
          layout="vertical"
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("wiki", "Wiki", null, undefined, { href: "/wiki/E1" }),
            tab("overview", "Overview", <div>o</div>),
            tab("facts", "Facts", <div>f</div>),
          ]}
        />,
      );
      const wikiLink = screen.getByRole("link", { name: /Wiki/ });
      expect(wikiLink.getAttribute("href")).toBe("/wiki/E1");
    });

    it("query mode (default) is regression-free when tabRouting is omitted", () => {
      // No tabRouting prop → query-mode behavior unchanged from baseline tests.
      mockState.search = "tab=facts";
      render(
        <ProfileTabs
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("facts", "Facts", <div data-testid="facts-content">f</div>),
          ]}
        />,
      );
      const activeTab = screen.getByRole("tab", { selected: true });
      expect(activeTab.textContent).toMatch(/Facts/);
      expect(screen.getByTestId("facts-content")).toBeTruthy();
    });

    it("hydration parity: tablist structure is stable across pathname changes", () => {
      // Path mode skips Suspense, so there's no Fallback↔Inner swap. The
      // structural QUA-656 invariant for path mode is: the rendered tablist
      // (tab count, tag, role, hrefs) must NOT change as the URL changes.
      // Only `data-state` / `aria-selected` should differ between paths.
      const tabsArr = [
        tab("overview", "Overview", <div>o</div>),
        tab("facts", "Facts", <div>f</div>),
        tab("people", "People", <div>p</div>),
      ];

      mockState.pathname = basePath;
      const { rerender, container } = render(
        <ProfileTabs tabRouting={{ mode: "path", basePath }} tabs={tabsArr} />,
      );

      function shape() {
        const triggers = Array.from(
          container.querySelectorAll('[role="tab"]'),
        ) as HTMLElement[];
        return triggers.map((t) => ({
          tag: t.tagName,
          id: t.getAttribute("data-tab-id"),
          href: t.getAttribute("href"),
          label: t.textContent,
        }));
      }
      const before = shape();

      // Switch to a different known segment — same tabs, different active.
      mockState.pathname = `${basePath}/people`;
      rerender(
        <ProfileTabs tabRouting={{ mode: "path", basePath }} tabs={tabsArr} />,
      );
      expect(shape()).toEqual(before);
      // But the active state DID change.
      const states = (
        Array.from(container.querySelectorAll('[role="tab"]')) as HTMLElement[]
      ).map((t) => t.getAttribute("data-state"));
      expect(states).toEqual(["inactive", "inactive", "active"]);
    });

    it("URL-encodes tab ids with special characters in the rendered href", () => {
      mockState.pathname = basePath;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            // Pathological id with characters that would break the URL.
            tab("a/b c", "Slashes & spaces", <div>s</div>),
          ]}
        />,
      );
      const triggers = screen.getAllByRole("tab");
      expect(triggers[1].getAttribute("href")).toBe(`${basePath}/a%2Fb%20c`);
    });

    it("decodes encoded segments when matching them back to a tab id", () => {
      mockState.pathname = `${basePath}/a%2Fb%20c`;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div>o</div>),
            tab("a/b c", "Slashes & spaces", <div data-testid="weird-content">s</div>),
          ]}
        />,
      );
      // The encoded segment should be decoded and matched to the registered id.
      expect(screen.getByTestId("weird-content")).toBeTruthy();
    });

    it("renders the active TabsContent panel even though triggers are <Link>s, not <TabsTrigger>s", () => {
      // Critical guarantee for path mode: Radix <TabsContent value=X> renders
      // when the parent <Tabs value=X> matches, regardless of whether any
      // <TabsTrigger> with value=X is registered. Without this, path mode
      // would render the tab list but no panel content at all.
      mockState.pathname = `${basePath}/facts`;
      render(
        <ProfileTabs
          tabRouting={{ mode: "path", basePath }}
          tabs={[
            tab("overview", "Overview", <div data-testid="overview-content">o</div>),
            tab("facts", "Facts", <div data-testid="facts-content">f</div>),
          ]}
        />,
      );
      // Active panel content renders, wrapped in a Radix tabpanel.
      const facts = screen.getByTestId("facts-content");
      expect(facts).toBeTruthy();
      const factsPanel = facts.closest('[role="tabpanel"]');
      expect(factsPanel).not.toBeNull();
      expect(factsPanel?.getAttribute("data-state")).toBe("active");
      // Inactive panel: Radix returns null for non-matching values, so its
      // testid should not be in the DOM.
      expect(screen.queryByTestId("overview-content")).toBeNull();
    });

    it("throws when basePath is empty or just root", () => {
      // basePath must be a real mount point so default-tab href and segment
      // parsing are unambiguous. Catch this at render time, not silently in
      // the URL.
      const baseTabs = [
        tab("a", "A", <div>a</div>),
        tab("b", "B", <div>b</div>),
      ];
      // suppress React's error-boundary console output for this assertion
      const origError = console.error;
      console.error = () => {};
      try {
        expect(() =>
          render(
            <ProfileTabs tabRouting={{ mode: "path", basePath: "" }} tabs={baseTabs} />,
          ),
        ).toThrow(/non-root basePath/);
        expect(() =>
          render(
            <ProfileTabs tabRouting={{ mode: "path", basePath: "/" }} tabs={baseTabs} />,
          ),
        ).toThrow(/non-root basePath/);
      } finally {
        console.error = origError;
      }
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
