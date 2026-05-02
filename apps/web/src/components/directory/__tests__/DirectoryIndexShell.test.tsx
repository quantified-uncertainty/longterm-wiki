// @vitest-environment jsdom
/** DirectoryIndexShell — slot rendering and conditional sections (QUA-1005). */
import React from "react";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { DirectoryIndexShell } from "@components/directory/DirectoryIndexShell";

describe("DirectoryIndexShell", () => {
  it("renders title as h1 and description below it", () => {
    render(
      <DirectoryIndexShell
        title="Organizations"
        description="A directory of organizations."
      />,
    );
    const h1 = screen.getByRole("heading", { level: 1 });
    expect(h1.textContent).toBe("Organizations");
    expect(screen.getByText("A directory of organizations.")).toBeTruthy();
  });

  it("renders without a description when description is omitted", () => {
    const { container } = render(<DirectoryIndexShell title="Organizations" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      "Organizations",
    );
    expect(container.querySelector("p.text-muted-foreground")).toBeNull();
  });

  it("renders a description that is a ReactNode (not just a string)", () => {
    render(
      <DirectoryIndexShell
        title="Legislation"
        description={
          <span>
            <strong data-testid="rich">Rich</strong> description
          </span>
        }
      />,
    );
    expect(screen.getByTestId("rich").textContent).toBe("Rich");
  });

  it("renders breadcrumbs when provided", () => {
    render(
      <DirectoryIndexShell
        title="Grants"
        breadcrumbs={[
          { label: "Home", href: "/" },
          { label: "Grants" },
        ]}
      />,
    );
    expect(screen.getByLabelText("Breadcrumb")).toBeTruthy();
    expect(screen.getByRole("link", { name: "Home" })).toBeTruthy();
  });

  it("does not render the breadcrumb nav when breadcrumbs is empty", () => {
    render(<DirectoryIndexShell title="Grants" breadcrumbs={[]} />);
    expect(screen.queryByLabelText("Breadcrumb")).toBeNull();
  });

  it("renders the banner slot in document order between header and stats", () => {
    render(
      <DirectoryIndexShell
        title="AI Models"
        description="A directory of AI models."
        banner={<div data-testid="banner">banner</div>}
        stats={[{ label: "Models", value: "42" }]}
      />,
    );
    const banner = screen.getByTestId("banner");
    const description = screen.getByText("A directory of AI models.");
    const statCard = screen.getByText("Models");
    // banner sits AFTER the header description and BEFORE the stat card.
    expect(
      description.compareDocumentPosition(banner) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      banner.compareDocumentPosition(statCard) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders the stats grid with one ProfileStatCard per item", () => {
    render(
      <DirectoryIndexShell
        title="Grants"
        stats={[
          { label: "Total Grants", value: "1,234" },
          { label: "Total Funding", value: "$5B" },
          { label: "Funding Orgs", value: "42" },
        ]}
      />,
    );
    expect(screen.getAllByTestId("stat-card")).toHaveLength(3);
    expect(screen.getByText("Total Grants")).toBeTruthy();
    expect(screen.getByText("$5B")).toBeTruthy();
  });

  it("does not render the stats grid when stats is empty", () => {
    const { container } = render(
      <DirectoryIndexShell title="Organizations" stats={[]} />,
    );
    expect(container.querySelectorAll('[data-testid="stat-card"]')).toHaveLength(
      0,
    );
  });

  it("does not render the stats grid when stats is omitted", () => {
    const { container } = render(<DirectoryIndexShell title="Organizations" />);
    expect(container.querySelectorAll('[data-testid="stat-card"]')).toHaveLength(
      0,
    );
  });

  it("renders stat card sub and wraps in a link when href is given", () => {
    render(
      <DirectoryIndexShell
        title="Projects"
        stats={[
          {
            label: "Projects",
            value: "12",
            sub: "as of today",
            href: "/projects/all",
          },
        ]}
      />,
    );
    const link = screen.getByRole("link", { name: /Projects/ });
    expect(link.getAttribute("href")).toBe("/projects/all");
    expect(screen.getByText("as of today")).toBeTruthy();
  });

  it("renders beforeBody between stats and children", () => {
    render(
      <DirectoryIndexShell
        title="Grants"
        stats={[{ label: "Total Grants", value: "1,234" }]}
        beforeBody={<div data-testid="by-funder">By Funder</div>}
      >
        <div data-testid="body">Body</div>
      </DirectoryIndexShell>,
    );
    const statCard = screen.getByText("Total Grants");
    const beforeBody = screen.getByTestId("by-funder");
    const body = screen.getByTestId("body");
    expect(
      statCard.compareDocumentPosition(beforeBody) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      beforeBody.compareDocumentPosition(body) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  it("renders children as the main body", () => {
    render(
      <DirectoryIndexShell title="Organizations">
        <div data-testid="main-body">main body content</div>
      </DirectoryIndexShell>,
    );
    expect(screen.getByTestId("main-body")).toBeTruthy();
  });

  it("renders an empty shell when no description, banner, stats, beforeBody, or children are given", () => {
    const { container } = render(<DirectoryIndexShell title="Empty" />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Empty");
    expect(container.querySelectorAll('[data-testid="stat-card"]')).toHaveLength(
      0,
    );
  });

  it("escapes HTML-like content in title and stat labels (React default behavior)", () => {
    const { container } = render(
      <DirectoryIndexShell
        title='<img src=x onerror="alert(1)">'
        stats={[
          { label: '<script>evil</script>', value: "<b>42</b>" },
        ]}
      />,
    );
    // No script element, no img element — React rendered the strings as text.
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("b")).toBeNull();
    // The literal text appears in the DOM.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe(
      '<img src=x onerror="alert(1)">',
    );
    expect(screen.getByText("<b>42</b>")).toBeTruthy();
  });
});
