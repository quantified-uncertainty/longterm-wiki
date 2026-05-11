/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  ScorecardsMatrix,
  type ScorecardOrgRow,
} from "../scorecards-matrix";

/**
 * QUA-839: matrix cells must render a SourcingDot next to each value, in
 * `not_run` (white) state when no verdict row exists. The dot's tooltip
 * must include the verdict label when one is present.
 */
describe("ScorecardsMatrix — source-check dots", () => {
  function row(cells: ScorecardOrgRow["cells"]): ScorecardOrgRow {
    return {
      entityId: "sid_anthropic1",
      displayName: "Anthropic",
      slug: "anthropic",
      cells,
    };
  }

  it("renders an unchecked (white) dot when no sourcing verdict is present", () => {
    render(
      <ScorecardsMatrix
        orgRows={[
          row({
            fli_index: {
              source: "fli_index",
              scoreNumeric: null,
              scoreLetter: "C+",
              scoreRaw: "C+",
              publishedAt: "2025-07-01",
              sourcing: null,
            },
          }),
        ]}
      />,
    );

    const dot = screen.getByRole("img", { name: /sourcing/i });
    expect(dot).toBeInTheDocument();
    expect(dot.getAttribute("aria-label")).toMatch(/Not checked/i);
  });

  it("renders a verified (green) dot when verdict=confirmed", () => {
    render(
      <ScorecardsMatrix
        orgRows={[
          row({
            saferai: {
              source: "saferai",
              scoreNumeric: 84,
              scoreLetter: null,
              scoreRaw: "84",
              publishedAt: "2025-08-01",
              sourcing: { verdict: "confirmed", checkedAt: "2026-04-29" },
            },
          }),
        ]}
      />,
    );

    const dot = screen.getByRole("img", { name: /sourcing/i });
    expect(dot.getAttribute("aria-label")).toMatch(/Verified/i);
    expect(dot.getAttribute("title")).toContain("Verdict: confirmed");
  });

  it("renders a failed (red) dot when verdict=contradicted", () => {
    render(
      <ScorecardsMatrix
        orgRows={[
          row({
            fli_index: {
              source: "fli_index",
              scoreNumeric: null,
              scoreLetter: "F",
              scoreRaw: "F",
              publishedAt: "2025-08-01",
              sourcing: { verdict: "contradicted", checkedAt: null },
            },
          }),
        ]}
      />,
    );

    const dot = screen.getByRole("img", { name: /sourcing/i });
    expect(dot.getAttribute("aria-label")).toMatch(/Failed/i);
  });

  it("renders the formatted score text alongside the dot", () => {
    render(
      <ScorecardsMatrix
        orgRows={[
          row({
            fli_index: {
              source: "fli_index",
              scoreNumeric: null,
              scoreLetter: "B+",
              scoreRaw: "B+",
              publishedAt: null,
              sourcing: null,
            },
          }),
        ]}
      />,
    );

    expect(screen.getByText("B+")).toBeInTheDocument();
  });

  // Cover every TableBase verdict state the unified mapping exposes
  // (see apps/web/src/components/sourcing/sourcing-status.ts). If the
  // mapping regresses for one state, this catches it without relying
  // on the matrix component being aware of every value.
  const VERDICT_CASES: Array<{ verdict: string; label: RegExp }> = [
    { verdict: "outdated", label: /Needs attention/i },
    { verdict: "partial", label: /Needs attention/i },
    { verdict: "unverifiable", label: /Failed source check/i },
    { verdict: "not_applicable", label: /Not checked/i },
  ];

  for (const { verdict, label } of VERDICT_CASES) {
    it(`renders the right dot for verdict=${verdict}`, () => {
      render(
        <ScorecardsMatrix
          orgRows={[
            row({
              fmti: {
                source: "fmti",
                scoreNumeric: 50,
                scoreLetter: null,
                scoreRaw: "50",
                publishedAt: "2025-08-01",
                sourcing: { verdict, checkedAt: null },
              },
            }),
          ]}
        />,
      );

      const dot = screen.getByRole("img", { name: /sourcing/i });
      expect(dot.getAttribute("aria-label")).toMatch(label);
    });
  }

  it("does not render a dot when the cell is missing (em-dash placeholder)", () => {
    render(<ScorecardsMatrix orgRows={[row({})]} />);

    // Empty cells rendered as em-dashes should not have any sourcing dot.
    const dots = screen.queryAllByRole("img", { name: /sourcing/i });
    expect(dots).toHaveLength(0);
    expect(screen.getAllByText("—").length).toBeGreaterThan(0);
  });
});

/**
 * QUA-861: matrix column headers must link to the per-source detail page
 * (`/scorecards/[source]`). Without this, the directory page is a dead-end
 * — users can't navigate from cross-org comparison into a single scorecard's
 * full grades + snapshot history.
 */
describe("ScorecardsMatrix — column header links", () => {
  it("each scorecard column header links to /scorecards/<source>", () => {
    render(<ScorecardsMatrix orgRows={[]} />);

    const fliLink = screen.getByRole("link", { name: /FLI Index/i });
    expect(fliLink).toHaveAttribute("href", "/scorecards/fli_index");

    const saferAiLink = screen.getByRole("link", { name: /SaferAI/i });
    expect(saferAiLink).toHaveAttribute("href", "/scorecards/saferai");

    const seoulLink = screen.getByRole("link", { name: /Seoul Tracker/i });
    expect(seoulLink).toHaveAttribute("href", "/scorecards/seoul_tracker");
  });
});

/**
 * QUA-861: prose verdicts ("Weak", "Fulfilled") must NOT render in monospace
 * — letter grades and numbers stay mono, but prose looks wrong as mono and
 * should fall back to the default sans-serif.
 */
describe("ScorecardsMatrix — conditional cell font", () => {
  function rowWithCell(scoreLetter: string | null, scoreRaw: string) {
    return {
      entityId: "sid_test",
      displayName: "Test Org",
      slug: "test-org",
      cells: {
        seoul_tracker: {
          source: "seoul_tracker" as const,
          scoreNumeric: null,
          scoreLetter,
          scoreRaw,
          publishedAt: null,
          sourcing: null,
        },
      },
    };
  }

  it("renders letter grades in monospace+tabular-nums", () => {
    render(<ScorecardsMatrix orgRows={[rowWithCell("C+", "C+")]} />);
    const cell = screen.getByText("C+").closest("td");
    expect(cell?.className).toMatch(/font-mono/);
    expect(cell?.className).toMatch(/tabular-nums/);
  });

  it("does NOT render prose verdicts in monospace", () => {
    render(<ScorecardsMatrix orgRows={[rowWithCell(null, "Fulfilled")]} />);
    const cell = screen.getByText("Fulfilled").closest("td");
    expect(cell?.className).not.toMatch(/font-mono/);
    expect(cell?.className).not.toMatch(/tabular-nums/);
  });

  it("does NOT render multi-word verdicts in monospace", () => {
    render(<ScorecardsMatrix orgRows={[rowWithCell(null, "Very Weak")]} />);
    const cell = screen.getByText("Very Weak").closest("td");
    expect(cell?.className).not.toMatch(/font-mono/);
  });
});
