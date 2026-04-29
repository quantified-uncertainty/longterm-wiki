/**
 * Tests for the OECD AIM transform module.
 *
 * Pure functions only — no network, no DB. Covers the contract points that
 * would regress silently:
 *   - article body fields (body, thumbImage) are never emitted into `raw`
 *   - attribution FKs are always null (per QUA-696 scope)
 *   - re-running transform on the same input produces identical IDs
 *   - tags are type-prefixed and de-duplicated
 *   - upstreamSeverity falls back through most_severe_harm → harm_levels → null
 *   - summary truncation preserves the column budget
 *   - the route's MAX_SUMMARY_CHARS literal stays equal to ours (anti-drift)
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import {
  EXCLUDED_ARTICLE_BODY_FIELDS,
  aimPermalink,
  deriveUpstreamSeverity,
  generateIncidentId,
  sanitizeRawArticle,
  SUMMARY_MAX_CHARS,
  TITLE_MAX_CHARS,
  transformIncident,
  truncateSummary,
  type OecdAimArticleRaw,
  type OecdAimIncidentRaw,
} from "./transform.ts";

const FIXED_FETCH_TIME = "2026-04-29T00:00:00.000Z";

function baseOpts() {
  return { upstreamFetchedAt: FIXED_FETCH_TIME };
}

const sampleIncident: OecdAimIncidentRaw = {
  id: "2024-06-15-abcd",
  title: "Chatbot leaks customer data via prompt injection",
  articles: null,
  n_articles: 5,
  date: "2024-06-15",
  location: { location: null, country: "United States", country_code: "USA" },
  evidences: ["The system was used in production and leaked PII."],
  summary: "A customer service chatbot exposed personal information after a prompt-injection attack.",
  image: "https://example.com/img.png",
  company: null,
  concepts: [{ score: 5, type: "wiki", label: { eng: "Prompt injection" } }],
  properties: {
    principles: ["Privacy & data governance"],
    industries: ["Consumer services"],
    harm_types: ["Human or fundamental rights"],
    harm_levels: ["AI incident"],
    harmed_entities: ["Consumers"],
    most_severe_harm: null,
    business_functions: ["Customer service"],
    deployment_breadth: null,
    ai_tasks: ["Content generation"],
    autonomy_level: "Low-action autonomy (human-in-the-loop)",
    languages: ["eng"],
  },
  aiid_ids: [],
  language_counts: { eng: 5 },
  is_legacy: null,
};

const sampleArticles: OecdAimArticleRaw[] = [
  {
    title: "Chatbot exposes data",
    date: "2024-06-15",
    body: "FULL ARTICLE TEXT THAT MUST NEVER BE PERSISTED",
    publisher: "Example News",
    country: "United States",
    url: "https://news.example.com/chatbot-leak",
    image: "https://example.com/article-img.png",
    thumbImage: "https://example.com/article-thumb.png",
    evidences: ["evidence text"],
    concepts: [],
  },
  {
    title: "Earlier coverage",
    date: "2024-06-14",
    body: "",
    publisher: "Wire Service",
    country: null,
    url: "https://wire.example.com/early",
    image: null,
    thumbImage: null,
    evidences: null,
    concepts: null,
  },
];

describe("generateIncidentId", () => {
  it("is deterministic across calls", () => {
    expect(generateIncidentId("2024-06-15-abcd")).toBe(
      generateIncidentId("2024-06-15-abcd"),
    );
  });

  it("produces a 10-char id that fits the schema", () => {
    const id = generateIncidentId("2024-06-15-abcd");
    expect(id).toMatch(/^[A-Za-z0-9]{10}$/);
  });

  it("is distinct from the AIID seed namespace", async () => {
    // generateId hashes the seed; aiid:42 vs oecd-aim:42 must not collide.
    const { generateIncidentId: aiidGen } = await import(
      "../aiid/transform.ts"
    );
    expect(generateIncidentId("42")).not.toBe(aiidGen("42"));
  });
});

describe("aimPermalink", () => {
  it("matches the verified live URL pattern", () => {
    expect(aimPermalink("2024-06-15-abcd")).toBe(
      "https://oecd.ai/en/incidents/2024-06-15-abcd",
    );
  });
});

describe("truncateSummary", () => {
  it("returns short text unchanged", () => {
    expect(truncateSummary("hello", 100)).toBe("hello");
  });

  it("truncates with an ellipsis at a word boundary", () => {
    const long = "alpha beta gamma delta epsilon zeta eta theta iota";
    const out = truncateSummary(long, 25);
    expect(out.length).toBeLessThanOrEqual(25);
    expect(out.endsWith("...")).toBe(true);
    expect(out).not.toContain("zeta"); // truncated word must be cleanly dropped
  });

  it("respects the SUMMARY_MAX_CHARS budget", () => {
    const long = "x".repeat(SUMMARY_MAX_CHARS + 100);
    expect(truncateSummary(long).length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });
});

describe("sanitizeRawArticle", () => {
  it("strips body and thumbImage but keeps url/title/publisher", () => {
    const out = sanitizeRawArticle(sampleArticles[0]);
    expect(out.url).toBe("https://news.example.com/chatbot-leak");
    expect(out.title).toBe("Chatbot exposes data");
    expect(out.publisher).toBe("Example News");
    expect("body" in out).toBe(false);
    expect("thumbImage" in out).toBe(false);
  });

  it("doesn't mutate the input", () => {
    const input = { ...sampleArticles[0] };
    sanitizeRawArticle(input);
    expect(input.body).toBe("FULL ARTICLE TEXT THAT MUST NEVER BE PERSISTED");
  });

  it("EXCLUDED_ARTICLE_BODY_FIELDS lists body and thumbImage", () => {
    expect([...EXCLUDED_ARTICLE_BODY_FIELDS]).toContain("body");
    expect([...EXCLUDED_ARTICLE_BODY_FIELDS]).toContain("thumbImage");
  });
});

describe("deriveUpstreamSeverity", () => {
  it("prefers most_severe_harm when present", () => {
    const inc: OecdAimIncidentRaw = {
      ...sampleIncident,
      properties: { ...sampleIncident.properties, most_severe_harm: "high" },
    };
    expect(deriveUpstreamSeverity(inc)).toBe("high");
  });

  it("falls back to harm_levels joined+sorted", () => {
    const inc: OecdAimIncidentRaw = {
      ...sampleIncident,
      properties: {
        ...sampleIncident.properties,
        most_severe_harm: null,
        harm_levels: ["AI incident", "AI hazard"],
      },
    };
    expect(deriveUpstreamSeverity(inc)).toBe("AI hazard+AI incident");
  });

  it("returns null when neither field is populated", () => {
    const inc: OecdAimIncidentRaw = {
      ...sampleIncident,
      properties: {
        ...sampleIncident.properties,
        most_severe_harm: null,
        harm_levels: [],
      },
    };
    expect(deriveUpstreamSeverity(inc)).toBeNull();
  });

  it("respects the upstreamSeverity column budget (varchar(64))", () => {
    const inc: OecdAimIncidentRaw = {
      ...sampleIncident,
      properties: {
        ...sampleIncident.properties,
        most_severe_harm: null,
        harm_levels: Array.from({ length: 30 }, (_, i) => `harm-${i}`),
      },
    };
    const out = deriveUpstreamSeverity(inc);
    expect(out).not.toBeNull();
    expect(out!.length).toBeLessThanOrEqual(64);
  });
});

describe("transformIncident — license & attribution invariants", () => {
  it("never emits article body / thumbImage in raw", () => {
    const item = transformIncident(sampleIncident, sampleArticles, baseOpts());
    const json = JSON.stringify(item.raw);
    expect(json).not.toContain("FULL ARTICLE TEXT THAT MUST NEVER BE PERSISTED");
    expect(json).not.toContain("article-thumb");
  });

  it("strips body/thumbImage from inline articles[] when caller passes detail-shaped input", () => {
    const detailShaped: OecdAimIncidentRaw = {
      ...sampleIncident,
      articles: sampleArticles, // simulate detail endpoint payload
    };
    const item = transformIncident(detailShaped, sampleArticles, baseOpts());
    const inlineRaw = (item.raw.incident as OecdAimIncidentRaw).articles!;
    for (const a of inlineRaw) {
      expect("body" in a).toBe(false);
      expect("thumbImage" in a).toBe(false);
    }
  });

  it("emits null for orgId / developerOrgId / aiModelId / attributionConfidence", () => {
    const item = transformIncident(sampleIncident, sampleArticles, baseOpts());
    expect(item.orgId).toBeNull();
    expect(item.developerOrgId).toBeNull();
    expect(item.aiModelId).toBeNull();
    expect(item.attributionConfidence).toBeNull();
  });

  it("emits source = 'oecd-aim'", () => {
    const item = transformIncident(sampleIncident, [], baseOpts());
    expect(item.source).toBe("oecd-aim");
  });
});

describe("transformIncident — fields", () => {
  it("preserves the upstream incident id as sourceIncidentId", () => {
    const item = transformIncident(sampleIncident, [], baseOpts());
    expect(item.sourceIncidentId).toBe("2024-06-15-abcd");
  });

  it("uses the most-recent article URL as fullReportUrl", () => {
    const item = transformIncident(sampleIncident, sampleArticles, baseOpts());
    expect(item.fullReportUrl).toBe("https://news.example.com/chatbot-leak");
  });

  it("falls back to the AIM permalink when no article URLs are known", () => {
    const item = transformIncident(sampleIncident, [], baseOpts());
    expect(item.fullReportUrl).toBe(
      "https://oecd.ai/en/incidents/2024-06-15-abcd",
    );
  });

  it("emits a placeholder title/summary when upstream is empty", () => {
    const blank: OecdAimIncidentRaw = {
      ...sampleIncident,
      title: "",
      summary: "",
    };
    const item = transformIncident(blank, [], baseOpts());
    expect(item.title).toContain("2024-06-15-abcd");
    expect(item.summary).toContain("2024-06-15-abcd");
  });

  it("clamps title to TITLE_MAX_CHARS", () => {
    const long: OecdAimIncidentRaw = {
      ...sampleIncident,
      title: "x".repeat(TITLE_MAX_CHARS + 200),
    };
    const item = transformIncident(long, [], baseOpts());
    expect(item.title.length).toBeLessThanOrEqual(TITLE_MAX_CHARS);
  });

  it("clamps summary to SUMMARY_MAX_CHARS", () => {
    const long: OecdAimIncidentRaw = {
      ...sampleIncident,
      summary: "x ".repeat(SUMMARY_MAX_CHARS),
    };
    const item = transformIncident(long, [], baseOpts());
    expect(item.summary.length).toBeLessThanOrEqual(SUMMARY_MAX_CHARS);
  });

  it("emits type-prefixed, deduplicated, sorted tags", () => {
    const item = transformIncident(sampleIncident, [], baseOpts());
    expect(item.tags).toContain("aim-industry:Consumer services");
    expect(item.tags).toContain("aim-harm-level:AI incident");
    expect(item.tags).toContain("aim-principle:Privacy & data governance");
    expect(item.tags).toContain("aim-country:USA");
    // Sorted lex and deduped — check no duplicates
    const setLen = new Set(item.tags).size;
    expect(setLen).toBe(item.tags.length);
    const sorted = [...item.tags].sort();
    expect(item.tags).toEqual(sorted);
  });

  it("respects the route's per-tag char limit (64) by truncating long values", () => {
    const longProp: OecdAimIncidentRaw = {
      ...sampleIncident,
      properties: {
        ...sampleIncident.properties,
        industries: ["a".repeat(200)],
      },
    };
    const item = transformIncident(longProp, [], baseOpts());
    for (const tag of item.tags) expect(tag.length).toBeLessThanOrEqual(64);
  });

  it("emits report rows only for articles that have URLs", () => {
    const articles: OecdAimArticleRaw[] = [
      { title: "x", date: "2024-06-15", body: "", publisher: "p", url: "https://a.example.com/" },
      { title: "y", date: "2024-06-15", body: "", publisher: "q" }, // no URL
    ];
    const item = transformIncident(sampleIncident, articles, baseOpts());
    expect(item.reports).toHaveLength(1);
    expect(item.reports[0].url).toBe("https://a.example.com/");
  });

  it("populates report.language from incident.language_counts dominant value", () => {
    const articles: OecdAimArticleRaw[] = [
      { title: "x", body: "", url: "https://a.example.com/" },
    ];
    const inc: OecdAimIncidentRaw = {
      ...sampleIncident,
      language_counts: { eng: 2, kor: 5 }, // kor wins
    };
    const item = transformIncident(inc, articles, baseOpts());
    expect(item.reports[0].language).toBe("kor");
  });
});

/**
 * Anti-drift check — the route declares its own `MAX_SUMMARY_CHARS` literal
 * to avoid a wiki-server ↔ crux dependency. If the two drift apart, sync
 * payloads silently truncate to a shorter limit than the route allows (or
 * vice versa). Read the route source as plain text and parse out the value.
 */
describe("MAX_SUMMARY_CHARS anti-drift", () => {
  it("matches the route's declared MAX_SUMMARY_CHARS", () => {
    const here = dirname(fileURLToPath(import.meta.url));
    const routePath = resolve(
      here,
      "../../../apps/wiki-server/src/routes/tablebase/ai-incidents.ts",
    );
    const src = readFileSync(routePath, "utf-8");
    const match = src.match(/MAX_SUMMARY_CHARS\s*=\s*(\d+)/);
    expect(match, "MAX_SUMMARY_CHARS literal not found in route").not.toBeNull();
    expect(Number(match![1])).toBe(SUMMARY_MAX_CHARS);
  });
});
