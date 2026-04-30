/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ScorecardsSection } from "./scorecards-section";

/**
 * QUA-838: panel headers on the org-tab scorecards section must link to
 * the per-source detail page (`/scorecards/[source]`) and the publisher
 * (when their wiki entity exists) — not be plain text.
 *
 * QUA-861: the overall pill and per-dimension cells must drop `font-mono`
 * for prose verdicts (Fulfilled, Weak, …) and keep it for letter/numeric
 * grades.
 */

interface GradeRow {
  id: string;
  snapshotId: string;
  scorecardSource: string | null;
  publishedAt: string | null;
  isLatest: boolean | null;
  entityId: string;
  entityDisplayName: string;
  dimensionSlug: string;
  dimensionLabel: string;
  scoreNumeric: number | null;
  scoreLetter: string | null;
  scoreRaw: string;
  notes: string | null;
  sourcing: { verdict: string; checkedAt: string | null } | null;
}

function makeRow(overrides: Partial<GradeRow>): GradeRow {
  return {
    id: "row-1",
    snapshotId: "snap-1",
    scorecardSource: "fli_index",
    publishedAt: "2025-12-02",
    isLatest: true,
    entityId: "sid_anthropic",
    entityDisplayName: "Anthropic",
    dimensionSlug: "overall",
    dimensionLabel: "Overall",
    scoreNumeric: null,
    scoreLetter: "C+",
    scoreRaw: "C+",
    notes: null,
    sourcing: null,
    ...overrides,
  };
}

describe("ScorecardsSection — internal hyperlinks (QUA-838)", () => {
  it("links the panel heading to /scorecards/<source>", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "fli_index",
            publishedAt: "2025-12-02",
            rows: [makeRow({ scorecardSource: "fli_index" })],
          },
        ]}
      />,
    );

    const heading = screen.getByRole("link", { name: "FLI AI Safety Index" });
    expect(heading).toHaveAttribute("href", "/scorecards/fli_index");
  });

  it("links the publisher to its wiki entity when publisherSlug is set", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "fli_index",
            publishedAt: "2025-12-02",
            rows: [makeRow({ scorecardSource: "fli_index" })],
          },
        ]}
      />,
    );

    // FLI is the only source with publisherSlug defined.
    const publisherLink = screen.getByRole("link", {
      name: "Future of Life Institute",
    });
    expect(publisherLink).toHaveAttribute("href", "/organizations/fli");
  });

  it("renders the publisher as plain text when no slug is configured", () => {
    // AI Lab Watch has publisher "Zach Stein-Perlman" with no publisherSlug —
    // the publisher should appear as plain text, not a link.
    render(
      <ScorecardsSection
        groups={[
          {
            source: "ailabwatch",
            publishedAt: "2025-09-01",
            rows: [makeRow({ scorecardSource: "ailabwatch" })],
          },
        ]}
      />,
    );

    // Publisher name should be present in the document.
    expect(screen.getByText(/by Zach Stein-Perlman/)).toBeInTheDocument();
    // But there should be no link with the publisher name.
    const publisherLinks = screen
      .queryAllByRole("link")
      .filter((el) => /Zach Stein-Perlman/.test(el.textContent ?? ""));
    expect(publisherLinks).toHaveLength(0);
  });

  it("keeps the external Source ↗ link open in a new tab", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "fli_index",
            publishedAt: "2025-12-02",
            rows: [makeRow({ scorecardSource: "fli_index" })],
          },
        ]}
      />,
    );

    const sourceLink = screen.getByRole("link", { name: /Source/ });
    expect(sourceLink.getAttribute("target")).toBe("_blank");
    expect(sourceLink.getAttribute("rel")).toContain("noopener");
  });
});

describe("ScorecardsSection — conditional font on grade values (QUA-861)", () => {
  it("renders letter-grade overall in monospace", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "fli_index",
            publishedAt: "2025-12-02",
            rows: [
              makeRow({
                dimensionSlug: "overall",
                scoreLetter: "C+",
                scoreRaw: "C+",
              }),
            ],
          },
        ]}
      />,
    );

    const overall = screen.getByText("C+");
    expect(overall.className).toMatch(/font-mono/);
  });

  it("does NOT render a prose-verdict overall in monospace", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "seoul_tracker",
            publishedAt: "2025-02-10",
            rows: [
              makeRow({
                scorecardSource: "seoul_tracker",
                dimensionSlug: "overall",
                scoreLetter: null,
                scoreNumeric: null,
                scoreRaw: "Fulfilled",
              }),
            ],
          },
        ]}
      />,
    );

    const overall = screen.getByText("Fulfilled");
    expect(overall.className).not.toMatch(/font-mono/);
  });

  it("does NOT render prose-verdict per-dimension cells in monospace", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "ailabwatch",
            publishedAt: "2025-09-01",
            rows: [
              makeRow({
                scorecardSource: "ailabwatch",
                dimensionSlug: "risk-info-sharing",
                dimensionLabel: "Risk info sharing",
                scoreLetter: null,
                scoreNumeric: null,
                scoreRaw: "Weak",
              }),
            ],
          },
        ]}
      />,
    );

    const dimensionCell = screen.getByText("Weak").closest("dd");
    expect(dimensionCell?.className).not.toMatch(/font-mono/);
  });

  it("renders letter-grade per-dimension cells in monospace", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "fli_index",
            publishedAt: "2025-12-02",
            rows: [
              makeRow({
                dimensionSlug: "current-harms",
                dimensionLabel: "Current Harms",
                scoreLetter: "B-",
                scoreRaw: "B-",
              }),
            ],
          },
        ]}
      />,
    );

    const dimensionCell = screen.getByText("B-").closest("dd");
    expect(dimensionCell?.className).toMatch(/font-mono/);
  });
});
