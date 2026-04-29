/** @vitest-environment jsdom */
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import {
  VerdictHeader,
  buildDisagreementExplainer,
  type AggregationResultLike,
} from "./VerdictHeader";

const baseVerdict = {
  fieldName: null,
  verdict: "confirmed",
  confidence: 0.9,
  reasoning: null,
  lastComputedAt: null,
  needsRecheck: false,
};

describe("buildDisagreementExplainer", () => {
  it("returns null when there is only one contributing bucket", () => {
    const aggregation: AggregationResultLike = {
      verdict: "confirmed",
      confidence: 0.9,
      sourcesChecked: 3,
      contributing: [{ verdict: "confirmed", weight: 2.7, rowCount: 3 }],
      droppedNotApplicable: 0,
    };
    expect(buildDisagreementExplainer(aggregation)).toBeNull();
  });

  it("returns null for an unchecked aggregate even with contributing rows", () => {
    const aggregation: AggregationResultLike = {
      verdict: "unchecked",
      confidence: null,
      sourcesChecked: 2,
      contributing: [],
      droppedNotApplicable: 0,
    };
    expect(buildDisagreementExplainer(aggregation)).toBeNull();
  });

  it("explains a 3-confirmed vs 1-low-relevance-contradicted split", () => {
    const aggregation: AggregationResultLike = {
      verdict: "confirmed",
      confidence: 0.85,
      sourcesChecked: 4,
      contributing: [
        // 3 sources at 0.9 relevance → avg 0.9 (high)
        { verdict: "confirmed", weight: 2.7, rowCount: 3 },
        // 1 source at 0.2 relevance → avg 0.2 (low)
        { verdict: "contradicted", weight: 0.2, rowCount: 1 },
      ],
      droppedNotApplicable: 0,
    };
    const explainer = buildDisagreementExplainer(aggregation);
    expect(explainer).not.toBeNull();
    expect(explainer).toContain("Headline confirmed");
    expect(explainer).toContain("3 high-relevance sources confirmed");
    expect(explainer).toContain("1 low-relevance source contradicted");
  });

  it("describes high-relevance dissent without burying it", () => {
    const aggregation: AggregationResultLike = {
      verdict: "contradicted",
      confidence: 0.7,
      sourcesChecked: 3,
      contributing: [
        { verdict: "contradicted", weight: 1.7, rowCount: 2 },
        { verdict: "confirmed", weight: 0.85, rowCount: 1 },
      ],
      droppedNotApplicable: 0,
    };
    const explainer = buildDisagreementExplainer(aggregation);
    expect(explainer).toBe(
      "Headline contradicted — 2 high-relevance sources contradicted, 1 high-relevance source confirmed."
    );
  });
});

describe("VerdictHeader", () => {
  it("renders headline + reconciled explainer from a single aggregation result", () => {
    const aggregation: AggregationResultLike = {
      verdict: "confirmed",
      confidence: 0.85,
      sourcesChecked: 4,
      contributing: [
        { verdict: "confirmed", weight: 2.7, rowCount: 3 },
        { verdict: "contradicted", weight: 0.2, rowCount: 1 },
      ],
      droppedNotApplicable: 0,
    };

    render(
      <VerdictHeader
        verdict={baseVerdict}
        aggregation={aggregation}
        evidenceCount={4}
        uniqueSourceCount={4}
      />
    );

    const headline = screen.getByTestId("verdict-headline");
    expect(headline).toHaveTextContent("confirmed");

    const explainer = screen.getByTestId("verdict-explainer");
    expect(explainer).toHaveTextContent("Headline confirmed");
    expect(explainer).toHaveTextContent("3 high-relevance sources confirmed");
    expect(explainer).toHaveTextContent("1 low-relevance source contradicted");

    // The headline verdict matches the verdict named in the explainer —
    // they cannot drift because both are derived from `aggregation`.
    expect(explainer.textContent ?? "").toContain(headline.textContent ?? "");
  });

  it("does not render an explainer when evidence agrees", () => {
    const aggregation: AggregationResultLike = {
      verdict: "confirmed",
      confidence: 0.95,
      sourcesChecked: 3,
      contributing: [{ verdict: "confirmed", weight: 2.85, rowCount: 3 }],
      droppedNotApplicable: 0,
    };

    render(
      <VerdictHeader
        verdict={baseVerdict}
        aggregation={aggregation}
        evidenceCount={3}
        uniqueSourceCount={3}
      />
    );

    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(
      "confirmed"
    );
    expect(screen.queryByTestId("verdict-explainer")).toBeNull();
  });

  it("falls back to the persisted verdict when aggregation is missing", () => {
    render(
      <VerdictHeader
        verdict={{ ...baseVerdict, verdict: "outdated", confidence: 0.5 }}
        aggregation={null}
        evidenceCount={0}
        uniqueSourceCount={0}
      />
    );

    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(
      "outdated"
    );
    expect(screen.queryByTestId("verdict-explainer")).toBeNull();
  });

  it("uses aggregation.verdict for the headline (not the persisted verdict) when both are present", () => {
    // Simulates evidence updated since the persisted verdict was last
    // recomputed: the aggregation reflects current truth, the row is stale.
    const aggregation: AggregationResultLike = {
      verdict: "contradicted",
      confidence: 0.8,
      sourcesChecked: 3,
      contributing: [
        { verdict: "contradicted", weight: 1.7, rowCount: 2 },
        { verdict: "confirmed", weight: 0.5, rowCount: 1 },
      ],
      droppedNotApplicable: 0,
    };

    render(
      <VerdictHeader
        verdict={{ ...baseVerdict, verdict: "confirmed" }}
        aggregation={aggregation}
        evidenceCount={3}
        uniqueSourceCount={3}
      />
    );

    expect(screen.getByTestId("verdict-headline")).toHaveTextContent(
      "contradicted"
    );
    const explainer = screen.getByTestId("verdict-explainer");
    expect(explainer).toHaveTextContent("Headline contradicted");
  });

  it("renders the field caption when verdict has a fieldName", () => {
    render(
      <VerdictHeader
        verdict={{ ...baseVerdict, fieldName: "amount" }}
        aggregation={null}
        evidenceCount={1}
        uniqueSourceCount={1}
      />
    );
    expect(screen.getByText(/field: amount/)).toBeInTheDocument();
  });

  it("renders 1 check (singular) for a single evidence row", () => {
    render(
      <VerdictHeader
        verdict={baseVerdict}
        aggregation={null}
        evidenceCount={1}
        uniqueSourceCount={1}
      />
    );
    expect(screen.getByText(/1 check(?!s)/)).toBeInTheDocument();
  });

  it("strips internal tags from reasoning when stripInternalTags is provided", () => {
    render(
      <VerdictHeader
        verdict={{
          ...baseVerdict,
          reasoning: "[deterministic-row-match] confirmed via PG match",
        }}
        aggregation={null}
        evidenceCount={1}
        uniqueSourceCount={1}
        stripInternalTags={(s) => s.replace(/^\[[^\]]+\]\s*/, "")}
      />
    );
    expect(screen.getByText("confirmed via PG match")).toBeInTheDocument();
  });
});
