import { describe, it, expect } from "vitest";
import { verifyExcerpt, verifyExtractedReport } from "./span-verify.ts";
import type { ExtractedReport } from "./extract-eval-report.ts";

const SOURCE = `Pre-deployment evaluation of Anthropic's upgraded Claude 3.5 Sonnet
Published 2026-01-15 by the UK AI Safety Institute and the US AISI.

We evaluated the upgraded Claude 3.5 Sonnet model across four risk domains:
biological, cyber, software/AI development, and safeguard efficacy. The
evaluation found limited uplift on biological risks and no significant
new capability on cyber tasks.

Methodology: https://www.aisi.gov.uk/methodology
PDF: https://www.aisi.gov.uk/papers/claude-3-5-sonnet-eval.pdf
`;

function makeReport(overrides: Partial<ExtractedReport> = {}): ExtractedReport {
  return {
    title: null,
    publishedDate: null,
    riskDomain: null,
    preDeployment: null,
    findingsSummary: null,
    capabilityLevelsAssessed: null,
    methodologyUrl: null,
    reportPdfUrl: null,
    modelsNamed: [],
    notes: null,
    excerpts: {},
    ...overrides,
  };
}

describe("verifyExcerpt", () => {
  it("returns confidence 1.0 for exact substring", () => {
    const v = verifyExcerpt("limited uplift on biological", SOURCE);
    expect(v.verified).toBe(true);
    expect(v.confidence).toBe(1);
  });

  it("returns confidence 0.9 for whitespace-normalized match", () => {
    // Add extra spaces/newlines that don't appear in the source.
    const v = verifyExcerpt(
      "limited\n  uplift   on biological",
      SOURCE,
    );
    expect(v.verified).toBe(true);
    expect(v.confidence).toBe(0.9);
  });

  it("rejects empty excerpt with no-excerpt reason", () => {
    const v = verifyExcerpt("", SOURCE);
    expect(v.verified).toBe(false);
    expect(v.reason).toBe("no-excerpt");
  });

  it("rejects too-short excerpt", () => {
    const v = verifyExcerpt("AI", SOURCE);
    expect(v.verified).toBe(false);
    expect(v.reason).toBe("excerpt-too-short");
  });

  it("rejects excerpt that doesn't appear in source", () => {
    const v = verifyExcerpt(
      "this entirely fabricated quote about quantum supremacy",
      SOURCE,
    );
    expect(v.verified).toBe(false);
  });
});

describe("verifyExtractedReport", () => {
  it("verifies grounded fields and drops ungrounded ones", () => {
    const report = makeReport({
      title: "Pre-deployment evaluation of Claude 3.5 Sonnet",
      publishedDate: "2026-01-15",
      preDeployment: true,
      findingsSummary:
        "limited uplift on biological risks and no significant new capability on cyber",
      modelsNamed: ["Claude 3.5 Sonnet"],
      excerpts: {
        title: "Pre-deployment evaluation of Anthropic's upgraded Claude 3.5 Sonnet",
        published_date: "Published 2026-01-15",
        pre_deployment: "Pre-deployment evaluation",
        findings_summary:
          "limited uplift on biological risks and no significant new capability on cyber",
      },
    });

    const result = verifyExtractedReport(report, SOURCE);

    expect(result.verifiedReport.title).toBeTruthy();
    expect(result.verifiedReport.publishedDate).toBe("2026-01-15");
    expect(result.verifiedReport.preDeployment).toBe(true);
    expect(result.verifiedReport.findingsSummary).toBeTruthy();
    expect(result.droppedFields).toHaveLength(0);

    // modelsNamed and capabilityLevelsAssessed are skipped — confidence 0.5
    expect(result.confidenceMap.modelsNamed).toBe(0.5);
  });

  it("drops a field when its excerpt does not appear in source", () => {
    const report = makeReport({
      title: "Real Title",
      findingsSummary: "Models are catastrophically dangerous",
      excerpts: {
        title: "Pre-deployment evaluation of Anthropic's upgraded Claude 3.5 Sonnet",
        // Hallucinated finding — not in source
        findings_summary: "Models are catastrophically dangerous and should be banned immediately",
      },
    });

    const result = verifyExtractedReport(report, SOURCE);

    expect(result.verifiedReport.title).toBeTruthy(); // title excerpt is real
    expect(result.verifiedReport.findingsSummary).toBeNull(); // dropped
    expect(result.droppedFields).toContain("findingsSummary");
  });

  it("does not span-check URL fields", () => {
    const report = makeReport({
      methodologyUrl: "https://www.aisi.gov.uk/methodology-different",
      reportPdfUrl: "https://example.com/totally-different.pdf",
      excerpts: {
        // No excerpts for URL fields — the verifier should still pass them.
      },
    });

    const result = verifyExtractedReport(report, SOURCE);

    expect(result.verifiedReport.methodologyUrl).toBe(
      "https://www.aisi.gov.uk/methodology-different",
    );
    expect(result.verifiedReport.reportPdfUrl).toBe(
      "https://example.com/totally-different.pdf",
    );
  });

  it("handles report with no fields populated", () => {
    const result = verifyExtractedReport(makeReport(), SOURCE);
    expect(result.droppedFields).toHaveLength(0);
    expect(result.ungroundedFields).toHaveLength(0);
  });
});
