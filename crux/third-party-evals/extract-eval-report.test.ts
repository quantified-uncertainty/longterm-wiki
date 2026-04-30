import { describe, it, expect } from "vitest";
import {
  normalizeExtractedReport,
  mapContentType,
  toSyncItem,
  type ExtractResult,
} from "./extract-eval-report.ts";

describe("normalizeExtractedReport", () => {
  it("returns canonical empty shape for non-object input", () => {
    const out = normalizeExtractedReport(null);
    expect(out.title).toBeNull();
    expect(out.modelsNamed).toEqual([]);
    expect(out.excerpts).toEqual({});
  });

  it("preserves all valid scalar fields", () => {
    const out = normalizeExtractedReport({
      title: "Eval of Foo",
      published_date: "2026-01-15",
      risk_domain: ["biological", "cyber"],
      pre_deployment: true,
      findings_summary: "limited uplift",
      capability_levels_assessed: { biological: "limited" },
      methodology_url: "https://aisi.gov.uk/methodology",
      report_pdf_url: "https://aisi.gov.uk/foo.pdf",
      models_named: ["Claude 3.5 Sonnet"],
      notes: "internal review pending",
      excerpts: { title: "Eval of Foo", published_date: "Published 2026-01-15" },
    });
    expect(out.title).toBe("Eval of Foo");
    expect(out.publishedDate).toBe("2026-01-15");
    expect(out.riskDomain).toEqual(["biological", "cyber"]);
    expect(out.preDeployment).toBe(true);
    expect(out.findingsSummary).toBe("limited uplift");
    expect(out.capabilityLevelsAssessed).toEqual({ biological: "limited" });
    expect(out.methodologyUrl).toBe("https://aisi.gov.uk/methodology");
    expect(out.reportPdfUrl).toBe("https://aisi.gov.uk/foo.pdf");
    expect(out.modelsNamed).toEqual(["Claude 3.5 Sonnet"]);
    expect(out.notes).toBe("internal review pending");
    expect(out.excerpts.title).toBe("Eval of Foo");
  });

  it("filters risk_domain to controlled vocab", () => {
    const out = normalizeExtractedReport({
      risk_domain: ["biological", "cyber", "definitely-not-real-domain", "scheming"],
    });
    expect(out.riskDomain).toEqual(["biological", "cyber", "scheming"]);
  });

  it("returns null riskDomain when no values pass the vocab filter", () => {
    const out = normalizeExtractedReport({
      risk_domain: ["unknown1", "unknown2"],
    });
    expect(out.riskDomain).toBeNull();
  });

  it("dedups risk_domain", () => {
    const out = normalizeExtractedReport({
      risk_domain: ["cyber", "biological", "cyber"],
    });
    expect(out.riskDomain).toEqual(["cyber", "biological"]);
  });

  it("coerces string boolean for pre_deployment", () => {
    expect(normalizeExtractedReport({ pre_deployment: "true" }).preDeployment).toBe(true);
    expect(normalizeExtractedReport({ pre_deployment: "false" }).preDeployment).toBe(false);
    expect(normalizeExtractedReport({ pre_deployment: null }).preDeployment).toBeNull();
    // Unparseable booleans become null (ambiguous).
    expect(normalizeExtractedReport({ pre_deployment: "maybe" }).preDeployment).toBeNull();
  });

  it("filters non-string entries from models_named", () => {
    const out = normalizeExtractedReport({
      models_named: ["Claude", null, 42, "GPT-4o", { foo: "bar" }, "  "],
    });
    expect(out.modelsNamed).toEqual(["Claude", "GPT-4o"]);
  });

  it("trims whitespace from string fields and treats whitespace-only as null", () => {
    const out = normalizeExtractedReport({
      title: "   ",
      findings_summary: "  real summary  ",
    });
    expect(out.title).toBeNull();
    expect(out.findingsSummary).toBe("real summary");
  });

  it("does not crash on adversarial input shapes", () => {
    expect(() => normalizeExtractedReport({ title: { foo: "bar" } })).not.toThrow();
    expect(() => normalizeExtractedReport({ risk_domain: "not-an-array" })).not.toThrow();
    expect(() => normalizeExtractedReport({ models_named: { 0: "Claude" } })).not.toThrow();
    expect(() => normalizeExtractedReport([])).not.toThrow();
  });
});

describe("mapContentType", () => {
  it("classifies arxiv URLs", () => {
    expect(mapContentType("html", "https://arxiv.org/abs/2401.12345")).toBe("arxiv-paper");
    expect(mapContentType("pdf", "https://arxiv.org/pdf/2401.12345.pdf")).toBe("arxiv-paper");
  });

  it("classifies PDFs", () => {
    expect(mapContentType("pdf", "https://aisi.gov.uk/eval.pdf")).toBe("pdf");
    expect(mapContentType("html", "https://aisi.gov.uk/eval.pdf")).toBe("pdf"); // URL-based fallback
  });

  it("classifies markdown URLs", () => {
    expect(mapContentType("html", "https://github.com/foo/bar/blob/main/README.md")).toBe("markdown");
  });

  it("defaults to html", () => {
    expect(mapContentType("html", "https://aisi.gov.uk/blog/foo")).toBe("html");
    expect(mapContentType("unknown", "https://aisi.gov.uk/blog/foo")).toBe("html");
  });
});

describe("toSyncItem", () => {
  function makeExtract(): ExtractResult {
    return {
      report: {
        title: "Eval of Foo",
        publishedDate: "2026-01-15",
        riskDomain: ["biological"],
        preDeployment: true,
        findingsSummary: "limited uplift",
        capabilityLevelsAssessed: null,
        methodologyUrl: null,
        reportPdfUrl: null,
        modelsNamed: ["Claude 3.5 Sonnet"],
        notes: null,
        excerpts: {},
      },
      sourceText: "fake source",
      sourceFormat: "html",
      sourceHash: "deadbeef",
      waybackSnapshotUrl: null,
      usage: { input_tokens: 1000, output_tokens: 500 },
      extractorVersion: "third-party-eval-extractor@1.0",
      extractionModel: "claude-haiku-4-5",
      extractedAt: "2026-04-25T10:00:00Z",
    };
  }

  it("produces a payload that matches schema field names", () => {
    const item = toSyncItem(makeExtract(), {
      id: "abc1234567",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      evaluatorOrgDisplayName: "UK AISI",
      reportUrl: "https://aisi.gov.uk/blog/foo",
      sourceSystem: "sitemap",
      models: [
        {
          aiModelId: "sid_ISfAiImMYg",
          rawNameInReport: "Claude 3.5 Sonnet",
          matchConfidence: "exact",
        },
      ],
      confidenceMap: { title: 1, publishedDate: 1 },
    });

    expect(item.id).toBe("abc1234567");
    expect(item.evaluatorOrgId).toBe("sid_aX0jkoaekQ");
    expect(item.reportUrl).toBe("https://aisi.gov.uk/blog/foo");
    expect(item.title).toBe("Eval of Foo");
    expect(item.riskDomain).toEqual(["biological"]);
    expect(item.preDeployment).toBe(true);
    expect(item.sourceFormat).toBe("html");
    expect(item.sourceHash).toBe("deadbeef");
    expect(item.sourceSystem).toBe("sitemap");
    expect(item.extractionConfidence).toEqual({ title: 1, publishedDate: 1 });
    expect((item.models as unknown[])).toHaveLength(1);
  });

  it("falls back to misc risk_domain when extractor returned none", () => {
    const e = makeExtract();
    e.report.riskDomain = null;
    const item = toSyncItem(e, {
      id: "abc1234567",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      reportUrl: "https://aisi.gov.uk/blog/foo",
      sourceSystem: "sitemap",
      confidenceMap: {},
    });
    expect(item.riskDomain).toEqual(["misc"]);
  });

  it("provides a sentinel title when extraction lacked one", () => {
    const e = makeExtract();
    e.report.title = null;
    const item = toSyncItem(e, {
      id: "abc1234567",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      reportUrl: "https://aisi.gov.uk/blog/foo",
      sourceSystem: "sitemap",
      confidenceMap: {},
    });
    expect(item.title).toBe("(untitled report)");
  });

  it("omits models field when caller passes undefined (partial sync)", () => {
    const item = toSyncItem(makeExtract(), {
      id: "abc1234567",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      reportUrl: "https://aisi.gov.uk/blog/foo",
      sourceSystem: "sitemap",
      confidenceMap: {},
      // models: undefined
    });
    expect("models" in item).toBe(false);
  });

  it("includes models: [] when caller wants to clear links explicitly", () => {
    const item = toSyncItem(makeExtract(), {
      id: "abc1234567",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      reportUrl: "https://aisi.gov.uk/blog/foo",
      sourceSystem: "sitemap",
      confidenceMap: {},
      models: [],
    });
    expect(item.models).toEqual([]);
  });

  it("includes sourcing block when provided (QUA-727)", () => {
    const item = toSyncItem(makeExtract(), {
      id: "abc1234567",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      reportUrl: "https://aisi.gov.uk/blog/foo",
      sourceSystem: "sitemap",
      confidenceMap: {},
      sourcing: {
        verdict: "confirmed",
        confidence: 0.95,
        evidence: "Pre-deployment evaluation excerpt",
        checkedBy: "span-verify-v1",
        checkedAt: "2026-04-25T10:30:00.000Z",
        sourceContentHash: "deadbeef",
      },
    });

    expect(item.sourcing).toMatchObject({
      verdict: "confirmed",
      checkedBy: "span-verify-v1",
    });
  });

  it("omits sourcing block when not provided", () => {
    const item = toSyncItem(makeExtract(), {
      id: "abc1234567",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      reportUrl: "https://aisi.gov.uk/blog/foo",
      sourceSystem: "sitemap",
      confidenceMap: {},
    });
    expect("sourcing" in item).toBe(false);
  });

  it("omits sourcing block when null is passed", () => {
    const item = toSyncItem(makeExtract(), {
      id: "abc1234567",
      evaluatorOrgId: "sid_aX0jkoaekQ",
      reportUrl: "https://aisi.gov.uk/blog/foo",
      sourceSystem: "sitemap",
      confidenceMap: {},
      sourcing: null,
    });
    expect("sourcing" in item).toBe(false);
  });
});
