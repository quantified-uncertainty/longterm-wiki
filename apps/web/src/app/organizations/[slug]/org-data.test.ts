/**
 * Tests for resource title filtering and normalization in org-data.ts.
 *
 * These functions are not exported, so we test them via a minimal harness
 * that re-implements the core logic. If the functions are refactored to be
 * exported, these tests should import them directly.
 */
import { describe, it, expect } from "vitest";

// ── Re-implement core functions for testing (mirrors org-data.ts) ──

const SOURCE_NAMES = new Set([
  "reuters", "cnbc", "bbc", "nytimes", "the new york times",
  "the washington post", "the guardian", "wired", "techcrunch",
  "the verge", "ars technica", "nature", "science", "arxiv",
  "rand", "fortune", "bloomberg", "the information", "time",
  "the economist", "mit technology review", "financial times",
  "associated press", "ap news", "vox", "politico", "axios",
]);

function isGenericTitle(title: string, orgName: string): boolean {
  const t = title.toLowerCase().trim();
  const org = orgName.toLowerCase();
  if (t === org) return true;
  if (new RegExp(`^${org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(\\d{4}\\)$`).test(t)) return true;
  if (t === `${org}'s` || t === `${org} acknowledged`) return true;
  if (t.length < 10 && t.startsWith(org.slice(0, 5))) return true;
  if (SOURCE_NAMES.has(t)) return true;
  if (/^[A-Z][a-z]+(\s+(et\s+al\.|&\s+[A-Z][a-z]+))\s*\(\d{4}\)\s*$/i.test(title.trim())) return true;
  if (t.length < 15 && !t.includes(" ")) return true;
  if (/^\d[\d.]*$/.test(t)) return true;
  if (/^v\d/i.test(t) && t.length < 10) return true;
  return false;
}

function isSectionPage(title: string, orgName: string): boolean {
  const t = title.toLowerCase().trim();
  const org = orgName.toLowerCase();
  const standaloneWords = new Set([
    "careers", "team", "about", "blog", "publications",
    "research", "news", "press", "leadership", "contact", "jobs",
  ]);
  if (standaloneWords.has(t)) return true;
  const sectionPatterns = [
    `${org} blog`, `${org} safety blog`, `${org} research`,
    `${org} safety research`, `${org} alignment science`,
    `${org} careers`, `${org} news`, `${org} updates`,
    `${org} evals`, `${org} documented`,
    `${org} team`, `${org} about`, `${org} press`,
    `${org} leadership`, `${org} contact`, `${org} jobs`,
    `${org} publications`,
    `about ${org}`,
  ];
  return sectionPatterns.includes(t);
}

function isPersonNameOnly(title: string): boolean {
  const parts = title.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((p) => /^[A-Z][a-z]+\.?$/.test(p) || /^(de|van|von|al|el|bin|ibn|del|la|di)$/i.test(p));
}

function decodeHtmlEntities(s: string): string {
  return s
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&#8211;/g, "–")
    .replace(/&#8212;/g, "—")
    .replace(/&#8216;/g, "\u2018")
    .replace(/&#8217;/g, "\u2019")
    .replace(/&#8220;/g, "\u201C")
    .replace(/&#8221;/g, "\u201D")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function fixAcronymCasing(title: string): string {
  return title
    .replace(/\bAi\b/g, "AI")
    .replace(/\bLlm(s?)\b/g, "LLM$1")
    .replace(/\bMl\b/g, "ML")
    .replace(/\bGpt\b/g, "GPT")
    .replace(/\bAsl\b/g, "ASL")
    .replace(/\bRlhf\b/g, "RLHF")
    .replace(/\bRsp\b/g, "RSP")
    .replace(/\bApi\b/g, "API");
}

function titleFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/\/$/, "");
    const lastSegment = path.split("/").filter(Boolean).pop();
    if (!lastSegment) return null;
    const raw = lastSegment
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return fixAcronymCasing(raw);
  } catch {
    return null;
  }
}

function cleanTitle(title: string, orgName: string): string {
  let t = decodeHtmlEntities(title);
  t = t.replace(/\\(\$)/g, "$1");
  // Strip inline citation format: 'Author, "Title" (https://...)' or 'Author, *Title* (https://...)'
  const citationMatch = t.match(/^.{2,50},\s*[*"'](.+?)[*"']\s*\(https?:\/\//);
  if (citationMatch) {
    t = citationMatch[1];
  }
  t = t.replace(/\s*\|\s*[^|]+\(https?:\/\/[^)]+\)\s*$/, "");
  const escaped = orgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  t = t.replace(new RegExp(`\\s*\\|\\s*${escaped}\\s*$`, "i"), "");
  t = t.replace(new RegExp(`\\s*-\\s*${escaped}\\s*$`, "i"), "");
  t = t.replace(new RegExp(`\\s*\\\\\\s*${escaped}\\s*$`, "i"), "");
  t = t.replace(/\s*\(https?:\/\/[^)]+\)\s*$/, "");
  const trailingSource = t.match(/\s*[-–—]\s*(.+)$/);
  if (trailingSource && SOURCE_NAMES.has(trailingSource[1].toLowerCase().trim())) {
    t = t.slice(0, -trailingSource[0].length);
  }
  // Strip markdown emphasis wrapping: **text** → text, *text* → text
  t = t.replace(/^\*\*(.+)\*\*$/, "$1");
  t = t.replace(/^\*(.+)\*$/, "$1");
  if (/^https?:\/\//.test(t.trim())) {
    const derived = titleFromUrl(t.trim());
    if (derived) return derived;
  }
  return t.trim();
}

// ── Tests ──

describe("isGenericTitle", () => {
  it("matches exact org name", () => {
    expect(isGenericTitle("Anthropic", "Anthropic")).toBe(true);
    expect(isGenericTitle("anthropic", "Anthropic")).toBe(true);
  });

  it("matches org name with year", () => {
    expect(isGenericTitle("Anthropic (2024)", "Anthropic")).toBe(true);
    expect(isGenericTitle("OpenAI (2023)", "OpenAI")).toBe(true);
  });

  it("matches source-name-only titles", () => {
    expect(isGenericTitle("Reuters", "Anthropic")).toBe(true);
    expect(isGenericTitle("CNBC", "OpenAI")).toBe(true);
    expect(isGenericTitle("The Guardian", "DeepMind")).toBe(true);
  });

  it("matches bibliographic format", () => {
    expect(isGenericTitle("Smith et al. (2022)", "Anthropic")).toBe(true);
    expect(isGenericTitle("Jones & Smith (2024)", "OpenAI")).toBe(true);
  });

  it("matches version strings", () => {
    expect(isGenericTitle("2.0", "Anthropic")).toBe(true);
    expect(isGenericTitle("v4.1", "OpenAI")).toBe(true);
  });

  it("matches short non-spaced fragments", () => {
    expect(isGenericTitle("interpretab", "Anthropic")).toBe(true);
    expect(isGenericTitle("safety", "Anthropic")).toBe(true);
  });

  it("does NOT match real titles", () => {
    expect(isGenericTitle("Constitutional AI: Harmlessness from AI Feedback", "Anthropic")).toBe(false);
    expect(isGenericTitle("GPT-4 Technical Report", "OpenAI")).toBe(false);
    expect(isGenericTitle("Scaling Laws for Neural Language Models", "Anthropic")).toBe(false);
  });

  it("does NOT match titles with spaces that are long enough", () => {
    expect(isGenericTitle("The Model Spec", "OpenAI")).toBe(false);
  });
});

describe("isSectionPage", () => {
  it("matches common section pages", () => {
    expect(isSectionPage("Anthropic Blog", "Anthropic")).toBe(true);
    expect(isSectionPage("Anthropic Research", "Anthropic")).toBe(true);
    expect(isSectionPage("Anthropic Careers", "Anthropic")).toBe(true);
  });

  it("matches standalone section words", () => {
    expect(isSectionPage("Careers", "Anthropic")).toBe(true);
    expect(isSectionPage("Team", "OpenAI")).toBe(true);
    expect(isSectionPage("About", "DeepMind")).toBe(true);
    expect(isSectionPage("Blog", "Anthropic")).toBe(true);
    expect(isSectionPage("Publications", "MIRI")).toBe(true);
    expect(isSectionPage("Research", "Anthropic")).toBe(true);
    expect(isSectionPage("News", "OpenAI")).toBe(true);
    expect(isSectionPage("Press", "DeepMind")).toBe(true);
    expect(isSectionPage("Leadership", "Anthropic")).toBe(true);
    expect(isSectionPage("Contact", "OpenAI")).toBe(true);
    expect(isSectionPage("Jobs", "DeepMind")).toBe(true);
  });

  it("matches new org-prefixed section patterns", () => {
    expect(isSectionPage("Anthropic Team", "Anthropic")).toBe(true);
    expect(isSectionPage("Anthropic About", "Anthropic")).toBe(true);
    expect(isSectionPage("Anthropic Press", "Anthropic")).toBe(true);
    expect(isSectionPage("Anthropic Leadership", "Anthropic")).toBe(true);
    expect(isSectionPage("Anthropic Contact", "Anthropic")).toBe(true);
    expect(isSectionPage("Anthropic Jobs", "Anthropic")).toBe(true);
    expect(isSectionPage("Anthropic Publications", "Anthropic")).toBe(true);
  });

  it("matches 'About Org' pattern", () => {
    expect(isSectionPage("About Anthropic", "Anthropic")).toBe(true);
    expect(isSectionPage("About OpenAI", "OpenAI")).toBe(true);
  });

  it("does NOT match real pages", () => {
    expect(isSectionPage("Anthropic's Responsible Scaling Policy", "Anthropic")).toBe(false);
  });
});

describe("isPersonNameOnly", () => {
  it("matches person names", () => {
    expect(isPersonNameOnly("Dario Amodei")).toBe(true);
    expect(isPersonNameOnly("Sam Altman")).toBe(true);
    expect(isPersonNameOnly("Jan van Leeuwen")).toBe(true);
  });

  it("does NOT match titles", () => {
    expect(isPersonNameOnly("Constitutional AI Paper")).toBe(false);
    expect(isPersonNameOnly("A")).toBe(false);
    expect(isPersonNameOnly("GPT-4 Technical Report on Safety")).toBe(false);
  });

  it("does NOT match titles with numbers or special chars", () => {
    expect(isPersonNameOnly("Claude 3.5")).toBe(false);
    expect(isPersonNameOnly("GPT-4")).toBe(false);
  });
});

describe("cleanTitle", () => {
  it("strips org suffix with pipe", () => {
    expect(cleanTitle("Research Update | Anthropic", "Anthropic")).toBe("Research Update");
  });

  it("strips org suffix with dash", () => {
    expect(cleanTitle("Research Update - Anthropic", "Anthropic")).toBe("Research Update");
  });

  it("strips embedded URL in parens", () => {
    expect(cleanTitle("Research Update (https://example.com/foo)", "Anthropic")).toBe("Research Update");
  });

  it("strips trailing news source", () => {
    expect(cleanTitle("Anthropic raises $2B - Reuters", "Anthropic")).toBe("Anthropic raises $2B");
  });

  it("decodes HTML entities", () => {
    expect(cleanTitle("It&#x27;s a test", "Org")).toBe("It's a test");
    expect(cleanTitle("A &amp; B", "Org")).toBe("A & B");
  });

  it("derives title from full URL", () => {
    const result = cleanTitle("https://anthropic.com/research/claude-3-model-card", "Anthropic");
    expect(result).toBe("Claude 3 Model Card");
  });

  it("strips MDX-escaped dollar signs", () => {
    expect(cleanTitle("Raises \\$2B", "Org")).toBe("Raises $2B");
  });

  it("strips inline citation format with quotes", () => {
    expect(cleanTitle('AISI, "Funding 60 projects" (https://example.com/foo)', "Org")).toBe("Funding 60 projects");
  });

  it("strips inline citation format with asterisks", () => {
    expect(cleanTitle("Author, *Some Important Title* (https://example.com/bar)", "Org")).toBe("Some Important Title");
  });

  it("strips inline citation format with single quotes", () => {
    expect(cleanTitle("Smith, 'A New Approach' (https://example.com/baz)", "Org")).toBe("A New Approach");
  });

  it("strips markdown bold wrapping", () => {
    expect(cleanTitle("**Bold Title Here**", "Org")).toBe("Bold Title Here");
  });

  it("strips markdown italic wrapping", () => {
    expect(cleanTitle("*Italic Title Here*", "Org")).toBe("Italic Title Here");
  });

  it("does NOT strip mid-title asterisks", () => {
    expect(cleanTitle("H*-complexity in AI systems", "Org")).toBe("H*-complexity in AI systems");
  });

  it("decodes en-dash and em-dash HTML entities", () => {
    expect(cleanTitle("AI &#8211; Safety", "Org")).toBe("AI – Safety");
    expect(cleanTitle("AI &#8212; Safety", "Org")).toBe("AI — Safety");
  });

  it("decodes smart quote HTML entities", () => {
    expect(cleanTitle("&#8216;Hello&#8217;", "Org")).toBe("\u2018Hello\u2019");
    // Single quotes should be proper Unicode curly quotes
    expect(cleanTitle("&#8220;Hello&#8221;", "Org")).toBe("\u201CHello\u201D");
  });

  it("decodes &nbsp; entity", () => {
    expect(cleanTitle("AI&nbsp;Safety", "Org")).toBe("AI Safety");
  });
});

describe("titleFromUrl", () => {
  it("derives title from URL path", () => {
    expect(titleFromUrl("https://anthropic.com/research/claude-3-model-card")).toBe("Claude 3 Model Card");
  });

  it("fixes AI acronym casing", () => {
    expect(titleFromUrl("https://example.com/blog/ai-safety-and-rlhf")).toBe("AI Safety And RLHF");
  });

  it("returns null for root URLs", () => {
    expect(titleFromUrl("https://anthropic.com/")).toBe(null);
  });

  it("returns null for invalid URLs", () => {
    expect(titleFromUrl("not-a-url")).toBe(null);
  });
});
