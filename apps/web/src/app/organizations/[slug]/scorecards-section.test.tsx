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
  waveLabel: string | null;
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
    waveLabel: "Winter 2025",
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
            history: [],
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
            history: [],
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

  it("links a person-publisher to /people/<slug> via getEntityHref (QUA-867)", () => {
    // AI Lab Watch's publisher is Zach Stein-Perlman — a *person* entity,
    // not an organization. Routing through getEntityHref means the link
    // goes to /people/zach-stein-perlman, not /organizations/<slug> (which
    // would 404). This is the regression QUA-867 item A guards against.
    render(
      <ScorecardsSection
        groups={[
          {
            source: "ailabwatch",
            publishedAt: "2025-09-01",
            rows: [makeRow({ scorecardSource: "ailabwatch" })],
            history: [],
          },
        ]}
      />,
    );

    const publisherLink = screen.getByRole("link", {
      name: "Zach Stein-Perlman",
    });
    expect(publisherLink).toHaveAttribute("href", "/people/zach-stein-perlman");
  });

  it("keeps the external Source ↗ link open in a new tab", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "fli_index",
            publishedAt: "2025-12-02",
            rows: [makeRow({ scorecardSource: "fli_index" })],
            history: [],
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
            history: [],
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
            history: [],
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
            history: [],
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
            history: [],
          },
        ]}
      />,
    );

    const dimensionCell = screen.getByText("B-").closest("dd");
    expect(dimensionCell?.className).toMatch(/font-mono/);
  });
});

describe("ScorecardsSection — grade trajectory mini-table (QUA-867 item E)", () => {
  it("hides the trajectory section when only one wave exists", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "saferai",
            publishedAt: "2025-10-01",
            rows: [
              makeRow({
                scorecardSource: "saferai",
                dimensionSlug: "overall",
                scoreLetter: "C",
                scoreRaw: "C",
              }),
            ],
            // SaferAI has been ingested for one wave only — no history yet.
            history: [
              {
                snapshotId: "saferai-2025-10",
                publishedAt: "2025-10-01",
                waveLabel: "October 2025",
                isLatest: true,
                scoreLetter: "C",
                scoreNumeric: null,
                scoreRaw: "C",
              },
            ],
          },
        ]}
      />,
    );

    expect(screen.queryByText(/Grade trajectory/)).toBeNull();
  });

  it("renders a collapsed trajectory summary with the wave count when ≥2 waves exist", () => {
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
            history: [
              {
                snapshotId: "fli_index-winter-2025",
                publishedAt: "2025-12-02",
                waveLabel: "Winter 2025",
                isLatest: true,
                scoreLetter: "C+",
                scoreNumeric: null,
                scoreRaw: "C+",
              },
              {
                snapshotId: "fli_index-summer-2025",
                publishedAt: "2025-07-17",
                waveLabel: "Summer 2025",
                isLatest: false,
                scoreLetter: "C-",
                scoreNumeric: null,
                scoreRaw: "C-",
              },
              {
                snapshotId: "fli_index-2024-12",
                publishedAt: "2024-12-11",
                waveLabel: "December 2024",
                isLatest: false,
                scoreLetter: "D",
                scoreNumeric: null,
                scoreRaw: "D",
              },
            ],
          },
        ]}
      />,
    );

    // Summary line shows the wave count.
    expect(screen.getByText(/Grade trajectory \(3 waves\)/)).toBeInTheDocument();
    // All three wave labels render in the dl, including the latest pill.
    expect(screen.getByText("Winter 2025")).toBeInTheDocument();
    expect(screen.getByText("Summer 2025")).toBeInTheDocument();
    expect(screen.getByText("December 2024")).toBeInTheDocument();
    expect(screen.getByText("latest")).toBeInTheDocument();
    // The historical D grade rendered (regression: prior implementation
    // would only show the latest).
    expect(screen.getByText("D")).toBeInTheDocument();
  });

  it("falls back to publishedAt when waveLabel is null", () => {
    render(
      <ScorecardsSection
        groups={[
          {
            source: "saferai",
            publishedAt: "2025-10-01",
            rows: [
              makeRow({
                scorecardSource: "saferai",
                dimensionSlug: "overall",
                scoreLetter: "C",
                scoreRaw: "C",
              }),
            ],
            history: [
              {
                snapshotId: "saferai-current",
                publishedAt: "2025-10-01",
                waveLabel: null,
                isLatest: true,
                scoreLetter: "C",
                scoreNumeric: null,
                scoreRaw: "C",
              },
              {
                snapshotId: "saferai-prev",
                publishedAt: "2025-04-15",
                waveLabel: null,
                isLatest: false,
                scoreLetter: "D",
                scoreNumeric: null,
                scoreRaw: "D",
              },
            ],
          },
        ]}
      />,
    );

    // No labels — show the dates instead.
    expect(screen.getByText("2025-10-01")).toBeInTheDocument();
    expect(screen.getByText("2025-04-15")).toBeInTheDocument();
  });
});
