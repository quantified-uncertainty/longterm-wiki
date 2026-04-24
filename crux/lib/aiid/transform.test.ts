/**
 * Tests for the AIID transform module.
 *
 * Pure functions only — no network, no DB. Covers the contract points that
 * would regress silently:
 *   - report body fields (text, plain_text) are never emitted
 *   - attribution FKs populate only when the AIID entity resolves in our catalog
 *   - re-running transform on the same input produces identical IDs
 *   - summary truncation preserves the column budget
 *   - title/summary fall back to placeholders when upstream is empty
 */

import { describe, it, expect } from "vitest";
import {
  EXCLUDED_REPORT_BODY_FIELDS,
  buildAiidEntityNameMap,
  buildEntityNameIndex,
  generateIncidentId,
  indexReportsByNumber,
  resolveAiidEntity,
  resolveIncidentReports,
  sanitizeRawReport,
  SUMMARY_MAX_CHARS,
  transformIncident,
  truncateSummary,
  type AiidEntityRaw,
  type AiidIncidentRaw,
  type AiidReportRaw,
} from "./transform.ts";

const FIXED_FETCH_TIME = "2026-04-24T00:00:00.000Z";

function baseOpts(overrides: Partial<Parameters<typeof transformIncident>[2]> = {}) {
  return {
    upstreamFetchedAt: FIXED_FETCH_TIME,
    aiidEntityNames: new Map<string, string>(),
    ourEntityIndex: new Map<string, string>(),
    ...overrides,
  };
}

const sampleIncident: AiidIncidentRaw = {
  incident_id: 42,
  title: "Chatbot gives harmful diet advice",
  date: "2024-11-15",
  description: "A deployed chatbot provided medically unsafe caloric recommendations.",
  "Alleged deployer of AI system": ["acme-corp"],
  "Alleged developer of AI system": ["widget-labs"],
  "Alleged harmed or nearly harmed parties": ["general public"],
  reports: [1, 2],
};

const sampleReports: AiidReportRaw[] = [
  {
    report_number: 1,
    url: "https://example.com/first-report",
    title: "First report",
    source_domain: "example.com",
    date_published: "2024-11-16",
    language: "en",
    // Banned fields — must not appear in output.
    plain_text: "The full article body goes here and should never be mirrored.",
    text: "Alternate body field also excluded from CC-BY-SA.",
  },
  {
    report_number: 2,
    url: "https://example.org/second-report",
    title: "Second report",
    source_domain: "example.org",
    date_published: "2024-11-18",
    language: "en",
    plain_text: "Another body.",
  },
];

describe("transformIncident", () => {
  it("produces a deterministic 10-char id from the upstream incident_id", () => {
    const out = transformIncident(sampleIncident, sampleReports, baseOpts());
    expect(out.id).toHaveLength(10);
    expect(out.id).toMatch(/^[0-9a-zA-Z]{10}$/);
    // Same input → same output
    const again = transformIncident(sampleIncident, sampleReports, baseOpts());
    expect(again.id).toBe(out.id);
  });

  it("preserves the upstream identifier in source + sourceIncidentId", () => {
    const out = transformIncident(sampleIncident, sampleReports, baseOpts());
    expect(out.source).toBe("mit-aiid");
    expect(out.sourceIncidentId).toBe("42");
  });

  it("never emits report.text or plain_text in raw or reports", () => {
    const out = transformIncident(sampleIncident, sampleReports, baseOpts());
    const json = JSON.stringify(out);
    for (const field of EXCLUDED_REPORT_BODY_FIELDS) {
      expect(json).not.toContain(`"${field}"`);
    }
    // reports array carries only URL/title/publisher/published_at/language
    for (const r of out.reports) {
      expect(Object.keys(r).sort()).toEqual(
        ["language", "publishedAt", "publisher", "title", "url"].sort(),
      );
    }
  });

  it("populates tags from AIID entity display names when available", () => {
    const aiidEntityNames = new Map([
      ["acme-corp", "Acme Corp"],
      ["widget-labs", "Widget Labs"],
    ]);
    const out = transformIncident(
      sampleIncident,
      sampleReports,
      baseOpts({ aiidEntityNames }),
    );
    expect(out.tags).toContain("aiid-entity:Acme Corp");
    expect(out.tags).toContain("aiid-entity:Widget Labs");
    // No raw slugs when we can't resolve them
    expect(out.tags).not.toContain("aiid-entity:general public");
  });

  it("leaves org/developer FKs NULL when our catalog has no matching entity", () => {
    const aiidEntityNames = new Map([
      ["acme-corp", "Acme Corp"],
      ["widget-labs", "Widget Labs"],
    ]);
    const out = transformIncident(
      sampleIncident,
      sampleReports,
      baseOpts({ aiidEntityNames }),
    );
    expect(out.orgId).toBeNull();
    expect(out.developerOrgId).toBeNull();
    expect(out.attributionConfidence).toBeNull();
  });

  it("populates org/developer FKs when names match our catalog", () => {
    const aiidEntityNames = new Map([
      ["acme-corp", "Acme Corp"],
      ["widget-labs", "Widget Labs"],
    ]);
    const ourEntityIndex = new Map([
      ["acme corp", "sid_acme00001"],
      ["widget labs", "sid_widgetlab"],
    ]);
    const out = transformIncident(
      sampleIncident,
      sampleReports,
      baseOpts({ aiidEntityNames, ourEntityIndex }),
    );
    expect(out.orgId).toBe("sid_acme00001");
    expect(out.developerOrgId).toBe("sid_widgetlab");
    expect(out.attributionConfidence).toBe(1.0);
  });

  it("falls back to the AIID permalink when no reports are linked", () => {
    const out = transformIncident(
      { ...sampleIncident, reports: [] },
      [],
      baseOpts(),
    );
    expect(out.fullReportUrl).toBe("https://incidentdatabase.ai/cite/42/");
  });

  it("picks the most-recently-published report as fullReportUrl", () => {
    const out = transformIncident(sampleIncident, sampleReports, baseOpts());
    expect(out.fullReportUrl).toBe("https://example.org/second-report");
  });

  it("coerces incident_id to string for sourceIncidentId", () => {
    const out = transformIncident(
      { ...sampleIncident, incident_id: 9001 },
      sampleReports,
      baseOpts(),
    );
    expect(out.sourceIncidentId).toBe("9001");
    expect(typeof out.sourceIncidentId).toBe("string");
  });

  it("falls back to a placeholder title/summary when upstream is empty", () => {
    const out = transformIncident(
      {
        incident_id: 77,
        title: "",
        description: null,
      } as AiidIncidentRaw,
      [],
      baseOpts(),
    );
    expect(out.title).toBe("AIID Incident 77");
    expect(out.summary).toBe("AIID incident 77");
  });

  it("caps summary at SUMMARY_MAX_CHARS", () => {
    const longDesc = "word ".repeat(2000);
    const out = transformIncident(
      { ...sampleIncident, description: longDesc },
      sampleReports,
      baseOpts(),
    );
    expect(out.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
    expect(out.summary.endsWith("...")).toBe(true);
  });

  it("propagates upstreamFetchedAt verbatim", () => {
    const out = transformIncident(sampleIncident, sampleReports, baseOpts());
    expect(out.upstreamFetchedAt).toBe(FIXED_FETCH_TIME);
  });

  it("leaves severity fields null (AIID has no structured severity)", () => {
    const out = transformIncident(sampleIncident, sampleReports, baseOpts());
    expect(out.severity).toBeNull();
    expect(out.upstreamSeverity).toBeNull();
  });
});

describe("sanitizeRawReport", () => {
  it("strips every EXCLUDED_REPORT_BODY_FIELDS key", () => {
    const sanitized = sanitizeRawReport(sampleReports[0]) as Record<string, unknown>;
    for (const field of EXCLUDED_REPORT_BODY_FIELDS) {
      expect(sanitized[field]).toBeUndefined();
    }
    // Allowed fields survive
    expect(sanitized.url).toBe(sampleReports[0].url);
    expect(sanitized.title).toBe(sampleReports[0].title);
  });

  it("is pure — does not mutate the input", () => {
    const input: AiidReportRaw = { ...sampleReports[0] };
    sanitizeRawReport(input);
    expect(input.plain_text).toBe(sampleReports[0].plain_text);
  });
});

describe("buildEntityNameIndex", () => {
  it("lowercases + trims name keys", () => {
    const idx = buildEntityNameIndex([
      { name: "  Anthropic  ", stableId: "sid_anthropic" },
      { name: "OpenAI", stableId: "sid_openai000" },
    ]);
    expect(idx.get("anthropic")).toBe("sid_anthropic");
    expect(idx.get("openai")).toBe("sid_openai000");
    expect(idx.get("Anthropic")).toBeUndefined(); // case-folded
  });

  it("first-wins on name collision", () => {
    const idx = buildEntityNameIndex([
      { name: "Apple", stableId: "sid_applecorp" },
      { name: "apple", stableId: "sid_applefrui" },
    ]);
    expect(idx.get("apple")).toBe("sid_applecorp");
  });

  it("skips entities without a stableId", () => {
    const idx = buildEntityNameIndex([
      { name: "Ghost", stableId: null },
      { name: "Real", stableId: "sid_realentty" },
    ]);
    expect(idx.has("ghost")).toBe(false);
    expect(idx.get("real")).toBe("sid_realentty");
  });

  it("skips empty-name rows", () => {
    const idx = buildEntityNameIndex([
      { name: "", stableId: "sid_empty00000" },
      { name: "   ", stableId: "sid_whitespace" },
    ]);
    expect(idx.size).toBe(0);
  });
});

describe("resolveAiidEntity", () => {
  const aiidNames = new Map([["acme-corp", "Acme Corp"]]);
  const ourIndex = new Map([["acme corp", "sid_acme00001"]]);

  it("resolves a known AIID id through our catalog", () => {
    const hit = resolveAiidEntity("acme-corp", aiidNames, ourIndex);
    expect(hit).toEqual({ stableId: "sid_acme00001", name: "Acme Corp" });
  });

  it("returns null when AIID doesn't know the id", () => {
    expect(resolveAiidEntity("who-knows", aiidNames, ourIndex)).toBeNull();
  });

  it("returns null when our catalog doesn't have the name", () => {
    const withName = new Map([["unknown-org", "Unknown Org"]]);
    expect(resolveAiidEntity("unknown-org", withName, ourIndex)).toBeNull();
  });
});

describe("indexReportsByNumber + resolveIncidentReports", () => {
  it("drops incidents whose report numbers are orphaned", () => {
    const idx = indexReportsByNumber(sampleReports);
    const linked = resolveIncidentReports(
      { ...sampleIncident, reports: [1, 999] },
      idx,
    );
    expect(linked).toHaveLength(1);
    expect(linked[0].report_number).toBe(1);
  });

  it("returns [] when the incident has no reports array", () => {
    const idx = indexReportsByNumber(sampleReports);
    const linked = resolveIncidentReports(
      { ...sampleIncident, reports: undefined },
      idx,
    );
    expect(linked).toEqual([]);
  });

  it("skips reports without a report_number", () => {
    const idx = indexReportsByNumber([
      { url: "x", report_number: undefined as unknown as number },
      { url: "y", report_number: 5 },
    ]);
    expect(idx.size).toBe(1);
    expect(idx.get(5)?.url).toBe("y");
  });
});

describe("truncateSummary", () => {
  it("returns short input unchanged", () => {
    expect(truncateSummary("short")).toBe("short");
  });

  it("hard caps at max", () => {
    const out = truncateSummary("a".repeat(10_000), 100);
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it("ends with ... when truncated", () => {
    const out = truncateSummary("a".repeat(200), 50);
    expect(out.endsWith("...")).toBe(true);
  });
});

describe("generateIncidentId", () => {
  it("produces a 10-char alphanumeric id", () => {
    const id = generateIncidentId("42");
    expect(id).toMatch(/^[0-9a-zA-Z]{10}$/);
  });

  it("is deterministic", () => {
    expect(generateIncidentId("42")).toBe(generateIncidentId("42"));
  });

  it("varies with input", () => {
    expect(generateIncidentId("42")).not.toBe(generateIncidentId("43"));
  });
});

describe("buildAiidEntityNameMap", () => {
  it("maps entity_id to name", () => {
    const aiidEntities: AiidEntityRaw[] = [
      { entity_id: "acme-corp", name: "Acme Corp" },
      { entity_id: "widget-labs", name: "Widget Labs" },
    ];
    const m = buildAiidEntityNameMap(aiidEntities);
    expect(m.get("acme-corp")).toBe("Acme Corp");
    expect(m.get("widget-labs")).toBe("Widget Labs");
  });

  it("skips malformed rows", () => {
    const aiidEntities: AiidEntityRaw[] = [
      { entity_id: "", name: "No ID" } as AiidEntityRaw,
      { entity_id: "good", name: "" } as AiidEntityRaw,
      { entity_id: "real", name: "Real" },
    ];
    const m = buildAiidEntityNameMap(aiidEntities);
    expect(m.size).toBe(1);
    expect(m.get("real")).toBe("Real");
  });
});
