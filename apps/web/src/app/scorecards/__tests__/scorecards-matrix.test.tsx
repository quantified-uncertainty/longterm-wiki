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
    { verdict: "unverifiable", label: /Needs attention/i },
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
