#!/usr/bin/env node

/**
 * Resource Data Quality Validator
 *
 * Checks all resources from the snapshot (or PG) for data quality issues
 * that indicate corrupted or poorly-scraped resource metadata.
 *
 * CI-blocking (errors):
 *   - Title contains HTML tags (<meta, <link, <title, <script, <div, etc.)
 *   - Title contains non-printable characters or is >500 chars
 *   - Title is just a URL (starts with http:// or https://)
 *
 * Actionable (warnings) — each one represents a real fixable problem:
 *   - Authors contain platform names (Substack, Medium, YouTube, etc.)
 *   - Type/subtype contradictions (type=paper but subtype contains blog, etc.)
 *   - Title is a domain name only (e.g., "www.example.com")
 *   - Title indicates a scraping failure ("Untitled", "404", "Access Denied", etc.)
 *   - Title looks auto-generated (all lowercase URL-like text, very short generic words)
 *
 * Informational (info) — for awareness, not actionable:
 *   - Title has zero word overlap with URL (common for academic citations)
 *
 * Usage:
 *   npx tsx crux/validate/validate-resource-quality.ts
 *   npx tsx crux/validate/validate-resource-quality.ts --ci
 *
 * Exit codes:
 *   0 = No blocking errors found
 *   1 = One or more blocking errors found
 */

import { existsSync, readFileSync } from "fs";
import { join } from "path";
import { PROJECT_ROOT } from "../lib/content-types.ts";
import { getColors } from "../lib/output.ts";
import type { Resource } from "../resource-types.ts";
import { truncate } from "../lib/text-utils.ts";

const SNAPSHOT_FILE = join(PROJECT_ROOT, "data/resources-snapshot.json");

// ---------------------------------------------------------------------------
// HTML tag patterns — matches common HTML tags that indicate scraped metadata
// ---------------------------------------------------------------------------

const HTML_TAG_PATTERN =
  /<(?:meta|link|title|script|div|span|style|head|body|html|img|iframe|noscript|header|footer|nav|main|section|article|aside|form|input|button|select|textarea|table|tr|td|th|ul|ol|li|p|br|hr|h[1-6])[\s>/]/i;

// ---------------------------------------------------------------------------
// Non-printable character detection (control chars except common whitespace)
// ---------------------------------------------------------------------------

// Allow tab (\t), newline (\n), carriage return (\r) — flag everything else
// in the C0 control range (0x00-0x1F) and DEL (0x7F)
const NON_PRINTABLE_PATTERN = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/;

// ---------------------------------------------------------------------------
// Platform names that should not appear as authors
// ---------------------------------------------------------------------------

export const PLATFORM_AUTHOR_NAMES = new Set([
  "substack",
  "medium",
  "youtube",
  "wordpress",
  "blogger",
  "ghost",
  "wix",
  "squarespace",
  "google",
  "facebook",
  "twitter",
  "linkedin",
]);

// ---------------------------------------------------------------------------
// Common stop words to exclude from URL/title overlap comparison
// ---------------------------------------------------------------------------

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "in",
  "on",
  "at",
  "to",
  "for",
  "of",
  "with",
  "by",
  "from",
  "as",
  "is",
  "was",
  "are",
  "were",
  "be",
  "been",
  "being",
  "have",
  "has",
  "had",
  "do",
  "does",
  "did",
  "will",
  "would",
  "could",
  "should",
  "may",
  "might",
  "can",
  "shall",
  "it",
  "its",
  "this",
  "that",
  "these",
  "those",
  "not",
  "no",
  "nor",
  "so",
  "if",
  "then",
  "than",
  "too",
  "very",
  "just",
  "about",
  "up",
  "out",
  "all",
  "each",
  "every",
  "both",
  "few",
  "more",
  "most",
  "other",
  "some",
  "such",
  "only",
]);

// ---------------------------------------------------------------------------
// Type/subtype contradiction rules
// ---------------------------------------------------------------------------

interface ContradictionRule {
  type: string;
  contradictingSubtypes: string[];
  description: string;
}

const TYPE_SUBTYPE_CONTRADICTIONS: ContradictionRule[] = [
  {
    type: "paper",
    contradictingSubtypes: ["blog", "news", "homepage", "social_media"],
    description: "type=paper but subtype suggests non-paper content",
  },
  {
    type: "blog",
    contradictingSubtypes: ["paper", "academic_paper", "journal_article"],
    description: "type=blog but subtype suggests academic content",
  },
  {
    type: "news",
    contradictingSubtypes: ["paper", "academic_paper", "journal_article"],
    description: "type=news but subtype suggests academic content",
  },
  {
    type: "homepage",
    contradictingSubtypes: ["paper", "academic_paper", "blog", "news"],
    description: "type=homepage but subtype suggests content page",
  },
];

// ---------------------------------------------------------------------------
// Domain-only title pattern
// ---------------------------------------------------------------------------

const DOMAIN_ONLY_PATTERN =
  /^(?:www\.)?[a-zA-Z0-9](?:[a-zA-Z0-9-]*[a-zA-Z0-9])?(?:\.[a-zA-Z]{2,})+$/;

// ---------------------------------------------------------------------------
// Core validation logic (exported for testing)
// ---------------------------------------------------------------------------

export interface ResourceQualityIssue {
  resourceId: string;
  url: string;
  field: string;
  message: string;
  severity: "error" | "warning" | "info";
}

// ---------------------------------------------------------------------------
// Scraping failure indicators — titles that suggest the scraper got an error
// page, placeholder, or anti-bot response instead of real content.
// ---------------------------------------------------------------------------

export const SCRAPING_FAILURE_PATTERNS: Array<{
  pattern: RegExp;
  label: string;
}> = [
  { pattern: /^untitled$/i, label: "Untitled" },
  { pattern: /^untitled\s+document$/i, label: "Untitled document" },
  { pattern: /^page$/i, label: "Page" },
  { pattern: /^home$/i, label: "Home" },
  { pattern: /^homepage$/i, label: "Homepage" },
  { pattern: /^index$/i, label: "Index" },
  { pattern: /^404\b/i, label: "404 error" },
  { pattern: /\b404\s*(not\s+found|error|page)\b/i, label: "404 error" },
  { pattern: /^not\s+found$/i, label: "Not Found" },
  { pattern: /^error$/i, label: "Error" },
  { pattern: /^access\s+denied$/i, label: "Access Denied" },
  { pattern: /^forbidden$/i, label: "Forbidden" },
  { pattern: /^just\s+a\s+moment/i, label: "Cloudflare challenge" },
  { pattern: /^attention\s+required/i, label: "Cloudflare challenge" },
  { pattern: /^loading\.{0,3}$/i, label: "Loading placeholder" },
  { pattern: /^please\s+wait/i, label: "Loading placeholder" },
  { pattern: /^redirecting/i, label: "Redirect page" },
  { pattern: /^sign\s+in/i, label: "Sign-in page" },
  { pattern: /^log\s*in$/i, label: "Login page" },
  { pattern: /^verify\s+you\s+are\s+human/i, label: "CAPTCHA" },
  { pattern: /^are\s+you\s+a\s+robot/i, label: "CAPTCHA" },
  { pattern: /^no\s+title$/i, label: "No title" },
];

/**
 * Detect if a title looks auto-generated or broken.
 * Returns a description of why it looks bad, or null if it looks legitimate.
 *
 * Heuristics:
 * - All lowercase + short (≤3 real words) + no punctuation → likely auto-generated
 * - Matches a URL slug pattern (all-lowercase-with-hyphens)
 * - Contains only numbers and/or very generic words
 */
export function detectAutoGeneratedTitle(
  title: string
): string | null {
  const trimmed = title.trim();

  // Title looks like a URL slug: all-lowercase-with-hyphens, no spaces
  // Check this first because slug-like titles are single "words" (no spaces)
  // and would otherwise be caught by the single-word exclusion below.
  if (
    /^[a-z0-9]+(?:-[a-z0-9]+){2,}$/.test(trimmed) &&
    trimmed.length > 5
  ) {
    return `Title looks like a URL slug: "${trimmed}"`;
  }

  // Very short generic titles (1-2 words, all lowercase, no meaningful content)
  const words = trimmed.split(/\s+/);
  if (
    words.length <= 2 &&
    trimmed === trimmed.toLowerCase() &&
    !/[.,()\[\]{}:;!?]/.test(trimmed)
  ) {
    // Exclude if it contains digits (might be a date or ID)
    if (!/\d/.test(trimmed)) {
      // Exclude single-word titles that are plausible (>8 chars)
      if (words.length === 1 && trimmed.length > 8) return null;
      // Only flag if the words look generic
      const genericWords = new Set([
        "new", "post", "article", "blog", "news", "update", "document",
        "file", "draft", "test", "temp", "tmp", "copy", "edit",
        "default", "sample", "demo", "welcome", "hello", "readme",
      ]);
      if (words.some((w) => genericWords.has(w))) {
        return `Title looks auto-generated: "${trimmed}"`;
      }
    }
  }

  return null;
}

/**
 * Extract meaningful words from a string, excluding stop words.
 * Returns lowercase words with 2+ characters.
 */
export function extractMeaningfulWords(text: string): Set<string> {
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
  return new Set(words);
}

/**
 * Extract words from a URL's path and domain for comparison.
 * Splits path segments and domain parts on common separators.
 */
export function extractUrlWords(url: string): Set<string> {
  try {
    const parsed = new URL(url);
    const parts = [
      // Domain without TLD
      ...parsed.hostname.replace(/^www\./, "").split(".").slice(0, -1),
      // Path segments
      ...parsed.pathname.split("/").filter(Boolean),
    ];
    // Split on hyphens, underscores, camelCase boundaries, and digits
    const words = parts
      .flatMap((part) =>
        part
          .replace(/([a-z])([A-Z])/g, "$1 $2")
          .replace(/[_-]/g, " ")
          .toLowerCase()
          .split(/\s+/)
      )
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w));
    return new Set(words);
  } catch {
    return new Set();
  }
}

/**
 * Check a single resource for data quality issues.
 */
export function checkResource(resource: Resource): ResourceQualityIssue[] {
  const issues: ResourceQualityIssue[] = [];
  const title = resource.title ?? "";
  const url = resource.url ?? "";

  // ── Blocking checks (errors) ──

  // 1. Title contains HTML tags
  if (title && HTML_TAG_PATTERN.test(title)) {
    issues.push({
      resourceId: resource.id,
      url,
      field: "title",
      message: `Title contains HTML tags: "${truncate(title, 103, { ellipsis: "..." })}"`,
      severity: "error",
    });
  }

  // 2. Title contains non-printable characters
  if (title && NON_PRINTABLE_PATTERN.test(title)) {
    const charCodes = [...title]
      .filter((ch) => NON_PRINTABLE_PATTERN.test(ch))
      .map((ch) => `0x${ch.charCodeAt(0).toString(16).padStart(2, "0")}`)
      .slice(0, 5);
    issues.push({
      resourceId: resource.id,
      url,
      field: "title",
      message: `Title contains non-printable characters (${charCodes.join(", ")}): "${title.slice(0, 80)}..."`,
      severity: "error",
    });
  }

  // 3. Title is excessively long (>500 chars)
  if (title && title.length > 500) {
    issues.push({
      resourceId: resource.id,
      url,
      field: "title",
      message: `Title is ${title.length} characters (max 500): "${title.slice(0, 80)}..."`,
      severity: "error",
    });
  }

  // 4. Title is just a URL (not merely starting with http)
  const trimmedTitle = title.trim();
  if (trimmedTitle && /^https?:\/\/\S+$/i.test(trimmedTitle)) {
    issues.push({
      resourceId: resource.id,
      url,
      field: "title",
      message: `Title is a raw URL: "${trimmedTitle.slice(0, 100)}"`,
      severity: "error",
    });
  }

  // ── Advisory checks (warnings) ──

  // 5. Authors contain platform names
  if (resource.authors && resource.authors.length > 0) {
    for (const author of resource.authors) {
      if (PLATFORM_AUTHOR_NAMES.has(author.toLowerCase().trim())) {
        issues.push({
          resourceId: resource.id,
          url,
          field: "authors",
          message: `Author is a platform name: "${author}"`,
          severity: "warning",
        });
      }
    }
  }

  // 6. Type/subtype contradictions
  if (resource.type && resource.resource_subtype) {
    const resourceType = resource.type.toLowerCase();
    const subtype = resource.resource_subtype.toLowerCase();
    for (const rule of TYPE_SUBTYPE_CONTRADICTIONS) {
      if (resourceType === rule.type) {
        for (const contraSubtype of rule.contradictingSubtypes) {
          if (subtype.includes(contraSubtype)) {
            issues.push({
              resourceId: resource.id,
              url,
              field: "type/resource_subtype",
              message: `${rule.description}: type="${resource.type}", subtype="${resource.resource_subtype}"`,
              severity: "warning",
            });
            break;
          }
        }
      }
    }
  }

  // 7. Title indicates a scraping failure (Untitled, 404, Access Denied, etc.)
  if (title) {
    const trimmedForScrape = title.trim();
    for (const { pattern, label } of SCRAPING_FAILURE_PATTERNS) {
      if (pattern.test(trimmedForScrape)) {
        issues.push({
          resourceId: resource.id,
          url,
          field: "title",
          message: `Title indicates scraping failure (${label}): "${trimmedForScrape.slice(0, 80)}"`,
          severity: "warning",
        });
        break; // One match is enough
      }
    }
  }

  // 8. Title looks auto-generated (URL slug, generic words)
  if (title && title.length >= 3) {
    const autoGenReason = detectAutoGeneratedTitle(title);
    if (autoGenReason) {
      issues.push({
        resourceId: resource.id,
        url,
        field: "title",
        message: autoGenReason,
        severity: "warning",
      });
    }
  }

  // 9. Title is a domain name only
  if (title && DOMAIN_ONLY_PATTERN.test(title.trim())) {
    issues.push({
      resourceId: resource.id,
      url,
      field: "title",
      message: `Title is a domain name only: "${title}"`,
      severity: "warning",
    });
  }

  // 10. Title has zero word overlap with URL path/domain (info-level — common for
  //     academic citations like "De Fauw et al. (2018)" on arxiv.org)
  if (title && url && title.length >= 3) {
    // Skip this check for very short titles (likely abbreviations) or URL-as-titles (already flagged)
    if (!/^https?:\/\//i.test(title.trim())) {
      const titleWords = extractMeaningfulWords(title);
      const urlWords = extractUrlWords(url);
      // Only flag if both sides have words to compare
      if (titleWords.size >= 2 && urlWords.size >= 1) {
        let overlap = 0;
        for (const word of titleWords) {
          if (urlWords.has(word)) {
            overlap++;
            break; // One overlap is enough to pass
          }
        }
        if (overlap === 0) {
          issues.push({
            resourceId: resource.id,
            url,
            field: "title",
            message: `Title has zero word overlap with URL: "${title.slice(0, 80)}"`,
            severity: "info",
          });
        }
      }
    }
  }

  return issues;
}

// ---------------------------------------------------------------------------
// Main validator function
// ---------------------------------------------------------------------------

export interface ResourceQualityResult {
  errors: string[];
  warnings: string[];
  infos: string[];
  issues: ResourceQualityIssue[];
  totalResources: number;
  skipped: boolean;
}

export function validateResourceQuality(options?: {
  resources?: Resource[];
}): ResourceQualityResult {
  let resources: Resource[];

  if (options?.resources) {
    resources = options.resources;
  } else {
    // Load from snapshot file
    if (!existsSync(SNAPSHOT_FILE)) {
      // No snapshot available — skip gracefully
      return {
        errors: [],
        warnings: [],
        infos: [],
        issues: [],
        totalResources: 0,
        skipped: true,
      };
    }
    try {
      const parsed = JSON.parse(readFileSync(SNAPSHOT_FILE, "utf-8"));
      if (!Array.isArray(parsed)) {
        return {
          errors: [
            `Invalid resources snapshot: expected array in ${SNAPSHOT_FILE}`,
          ],
          warnings: [],
          infos: [],
          issues: [],
          totalResources: 0,
          skipped: false,
        };
      }
      resources = parsed as Resource[];
    } catch (e: unknown) {
      return {
        errors: [
          `Failed to parse resources snapshot: ${e instanceof Error ? e.message : String(e)}`,
        ],
        warnings: [],
        infos: [],
        issues: [],
        totalResources: 0,
        skipped: false,
      };
    }
  }

  const allIssues: ResourceQualityIssue[] = [];

  for (const resource of resources) {
    const issues = checkResource(resource);
    allIssues.push(...issues);
  }

  const errors = allIssues
    .filter((i) => i.severity === "error")
    .map((i) => `[${i.resourceId}] ${i.message}`);
  const warnings = allIssues
    .filter((i) => i.severity === "warning")
    .map((i) => `[${i.resourceId}] ${i.message}`);
  const infos = allIssues
    .filter((i) => i.severity === "info")
    .map((i) => `[${i.resourceId}] ${i.message}`);

  return {
    errors,
    warnings,
    infos,
    issues: allIssues,
    totalResources: resources.length,
    skipped: false,
  };
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

if (process.argv[1]?.includes("validate-resource-quality")) {
  const c = getColors();
  console.log(
    `${c.blue}Checking resource data quality...${c.reset}\n`
  );

  const result = validateResourceQuality();

  if (result.skipped) {
    console.log(
      `${c.dim}No resources snapshot found — skipping resource quality check.${c.reset}`
    );
    console.log(
      `${c.dim}Run: pnpm crux wiki-server snapshot-resources${c.reset}`
    );
    process.exit(0);
  }

  console.log(
    `${c.dim}Checked ${result.totalResources} resources${c.reset}\n`
  );

  if (result.warnings.length > 0) {
    console.log(
      `${c.yellow}${result.warnings.length} warning(s):${c.reset}\n`
    );
    for (const w of result.warnings) {
      console.log(`  ${c.yellow}warning${c.reset} ${w}`);
    }
    console.log();
  }

  if (result.errors.length > 0) {
    console.log(
      `${c.red}${result.errors.length} error(s) (CI-blocking):${c.reset}\n`
    );
    for (const e of result.errors) {
      console.log(`  ${c.red}error${c.reset} ${e}`);
    }
    console.log();
  }

  // Info-level items are suppressed by default to keep output clean.
  // Show only a count summary.
  if (result.infos.length > 0) {
    console.log(
      `${c.dim}${result.infos.length} info(s) (awareness only, not actionable)${c.reset}`
    );
  }

  if (result.errors.length === 0 && result.warnings.length === 0) {
    console.log(
      `${c.green}No resource quality issues found${c.reset}`
    );
  } else if (result.errors.length === 0) {
    console.log(
      `${c.green}No blocking errors (${result.warnings.length} warning(s))${c.reset}`
    );
  }

  process.exit(result.errors.length > 0 ? 1 : 0);
}
