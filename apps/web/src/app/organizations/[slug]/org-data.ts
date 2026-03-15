/**
 * Data-fetching and parsing logic for organization profile pages.
 * Extracted from page.tsx as a pure refactor — no behavioral changes.
 */
import type { KBRecordEntry } from "@/data/factbase";
import {
  getKBLatest,
  getKBFacts,
  getKBProperty,
  getKBEntity,
  getKBEntities,
  getKBAllRecordCollections,
  resolveKBSlug,
  getKBEntitySlug,
  getKBRecords,
  getAllKBRecords,
} from "@/data/factbase";
import type { Fact } from "@longterm-wiki/factbase";
import {
  getTypedEntityById,
  getTypedEntities,
  isOrganization,
  isAiModel,
  getAllResources,
  getResourcesForPage,
  getResourceById,
  getResourceCredibility,
  getResourcePublication,
  getPagesForResource,
  getLiteraturePapers,
  type Resource,
  type LiteraturePaper,
} from "@/data";
import {
  formatKBNumber,
  titleCase,
  sortKBRecords,
} from "@/components/wiki/kb/format";
import { resolveRecipient } from "./org-shared";

// ── Numeric / range helpers ──────────────────────────────────────────

/** A numeric value that can be a single number or a [min, max] range. */
export type NumericOrRange = number | [number, number];

/** Parse a value that may be a single number or a 2-element array range. */
export function parseNumericOrRange(value: unknown): NumericOrRange | null {
  if (typeof value === "number") return value;
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => typeof v === "number")
  ) {
    return [value[0], value[1]] as [number, number];
  }
  return null;
}

/** Get a single numeric value from NumericOrRange (midpoint for ranges). */
export function numericValue(v: NumericOrRange | null): number {
  if (v == null) return 0;
  if (Array.isArray(v)) return (v[0] + v[1]) / 2;
  return v;
}

// ── Types ─────────────────────────────────────────────────────────────

export interface BoardMember {
  key: string;
  personId: string | null;
  personName: string;
  personHref: string | null;
  role: string | null;
  appointed: string | null;
  departed: string | null;
  appointedBy: string | null;
  source: string | null;
}

export interface RelatedOrg {
  id: string;
  name: string;
  slug: string | null;
  relationship: string;
  date: string | null;
}

export type ParsedGrantRecord = {
  key: string;
  name: string;
  recipient: string | null;
  recipientName: string;
  recipientHref: string | null;
  amount: NumericOrRange | null;
  date: string | null;
  status: string | null;
  source: string | null;
  programName: string | null;
  divisionName: string | null;
  notes: string | null;
};

export type ReceivedGrant = ParsedGrantRecord & {
  funderName: string;
  funderHref: string | null;
};

export type ParsedDivisionRecord = ReturnType<typeof parseDivisionRecord>;
export type ParsedFundingProgramRecord = ReturnType<typeof parseFundingProgramRecord>;
export type ParsedPersonnelRecord = ReturnType<typeof parsePersonnelRecord> & {
  personName: string;
  personHref: string | null;
};
export type ParsedFundingRoundRecord = ReturnType<typeof parseFundingRoundRecord> & {
  leadInvestorName: string;
  leadInvestorHref: string | null;
};
export type ParsedInvestmentRecord = ReturnType<typeof parseInvestmentRecord> & {
  investorName: string;
  investorHref: string | null;
};
export type ParsedEquityPositionRecord = ReturnType<typeof parseEquityPositionRecord> & {
  holderName: string;
  holderHref: string | null;
};

// ── Curated collection names ──────────────────────────────────────────
export const CURATED_COLLECTIONS = new Set([
  "funding-rounds",
  "investments",
  "key-persons",
  "products",
  "model-releases",
  "safety-milestones",
  "strategic-partnerships",
  "board-seats",
  "divisions",
  "funding-programs",
  "personnel",
  "grants",
  "equity-positions",
  "dilution-stages",
]);

// ── Constants ─────────────────────────────────────────────────────────

export const HERO_STATS = ["revenue", "valuation", "headcount", "total-funding"];

export { ORG_TYPE_LABELS, ORG_TYPE_COLORS, DEFAULT_ORG_TYPE_COLOR } from "@/app/organizations/org-constants";

export const FACT_CATEGORIES: { id: string; label: string; order: number }[] = [
  { id: "financial", label: "Financial", order: 0 },
  { id: "product", label: "Products & Usage", order: 1 },
  { id: "organization", label: "Organization", order: 2 },
  { id: "safety", label: "Safety & Research", order: 3 },
  { id: "people", label: "People", order: 4 },
  { id: "other", label: "Other", order: 99 },
];

export const SAFETY_LEVEL_COLORS: Record<string, string> = {
  "ASL-2": "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "ASL-3": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  "ASL-4": "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

export const MILESTONE_TYPE_COLORS: Record<string, string> = {
  "research-paper":
    "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  "policy-update":
    "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  "safety-eval":
    "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  "red-team":
    "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
};

export const MAX_GRANTS_SHOWN = 10;

// ── Formatting helpers ────────────────────────────────────────────────

export function formatAmount(value: unknown): string | null {
  if (value == null) return null;
  if (
    Array.isArray(value) &&
    value.length === 2 &&
    value.every((v) => typeof v === "number")
  ) {
    return `${formatKBNumber(value[0], "USD")}\u2013${formatKBNumber(value[1], "USD")}`;
  }
  const num = typeof value === "number" ? value : Number(value);
  if (isNaN(num)) return String(value);
  return formatKBNumber(num, "USD");
}

// ── Fact sidebar helpers ──────────────────────────────────────────────

/** Group facts by property, taking only the latest per property. */
export function getLatestFactsByProperty(
  facts: Fact[],
): Map<string, Fact> {
  const latest = new Map<string, Fact>();
  for (const fact of facts) {
    if (fact.propertyId === "description") continue;
    if (!latest.has(fact.propertyId)) {
      latest.set(fact.propertyId, fact);
    }
  }
  return latest;
}

/** Group property IDs by category, returning sorted categories. */
export function groupByCategory(
  propertyIds: string[],
): Array<{ category: string; label: string; props: string[] }> {
  const groups = new Map<string, string[]>();
  for (const propId of propertyIds) {
    const prop = getKBProperty(propId);
    const category = prop?.category ?? "other";
    const list = groups.get(category) ?? [];
    list.push(propId);
    groups.set(category, list);
  }

  const catMap = new Map(FACT_CATEGORIES.map((c) => [c.id, c]));
  return [...groups.entries()]
    .map(([catId, props]) => ({
      category: catId,
      label: catMap.get(catId)?.label ?? titleCase(catId),
      order: catMap.get(catId)?.order ?? 99,
      props,
    }))
    .sort((a, b) => a.order - b.order);
}

// ── Org age helper ───────────────────────────────────────────────────

export function computeOrgAge(foundedDateStr: string | undefined): string | null {
  if (!foundedDateStr) return null;
  const founded = new Date(foundedDateStr);
  if (isNaN(founded.getTime())) return null;
  const now = new Date();
  const years = now.getFullYear() - founded.getFullYear();
  const months = now.getMonth() - founded.getMonth();
  const totalMonths = years * 12 + months;
  if (totalMonths <= 0) return null;
  if (totalMonths < 12) return `${totalMonths} months`;
  const fullYears = Math.floor(totalMonths / 12);
  return `${fullYears} year${fullYears !== 1 ? "s" : ""} old`;
}

// ── Format a stake fraction for display (e.g., 0.15 -> "15%") ────────
export function formatStake(stake: NumericOrRange): string {
  if (Array.isArray(stake)) {
    const low = (stake[0] * 100).toFixed(1).replace(/\.0$/, "");
    const high = (stake[1] * 100).toFixed(1).replace(/\.0$/, "");
    return `${low}%\u2013${high}%`;
  }
  return `${(stake * 100).toFixed(1).replace(/\.0$/, "")}%`;
}

// ── Record parsers ───────────────────────────────────────────────────

export function parseGrantRecord(record: KBRecordEntry): ParsedGrantRecord {
  const f = record.fields;
  const recipientId = (f.recipient as string) ?? null;
  const resolved = recipientId ? resolveRecipient(recipientId) : { name: "", href: null };
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    recipient: recipientId,
    recipientName: resolved.name,
    recipientHref: resolved.href,
    amount: parseNumericOrRange(f.amount),
    date: (f.date as string) ?? (f.period as string) ?? null,
    status: (f.status as string) ?? null,
    source: (f.source as string) ?? null,
    programName: (f.programName as string) ?? null,
    divisionName: (f.divisionName as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export function parseDivisionRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    ownerEntityId: record.ownerEntityId,
    slug: (f.slug as string) ?? null,
    name: (f.name as string) ?? record.key,
    divisionType: (f.divisionType as string) ?? "team",
    lead: (f.lead as string) ?? null,
    status: (f.status as string) ?? null,
    startDate: (f.startDate as string) ?? null,
    endDate: (f.endDate as string) ?? null,
    website: (f.website as string) ?? null,
    source: (f.source as string) ?? null,
  };
}

export function parseFundingProgramRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    programType: (f.programType as string) ?? "grant-round",
    description: (f.description as string) ?? null,
    totalBudget: typeof f.totalBudget === "number" ? f.totalBudget : null,
    currency: (f.currency as string) ?? "USD",
    applicationUrl: (f.applicationUrl as string) ?? null,
    openDate: (f.openDate as string) ?? null,
    deadline: (f.deadline as string) ?? null,
    status: (f.status as string) ?? null,
    source: (f.source as string) ?? null,
  };
}

export function parsePersonnelRecord(record: KBRecordEntry) {
  const f = record.fields;
  const schema = record.schema;

  // Extract person ID — key-person and board use different field names
  const personId =
    (f.person as string) ?? (f.member as string) ?? null;

  // Extract role/title
  const role = (f.title as string) ?? (f.role as string) ?? null;

  // Extract dates — key-person uses start/end, board uses appointed/departed
  const startDate =
    (f.start as string) ?? (f.appointed as string) ?? null;
  const endDate =
    (f.end as string) ?? (f.departed as string) ?? null;

  const isFounder = (f.is_founder as boolean) ?? false;

  // Determine display role type from schema
  const roleType =
    schema === "key-person"
      ? "key-person"
      : schema === "board-seat"
        ? "board"
        : "career";

  return {
    key: record.key,
    personId,
    role,
    roleType,
    startDate,
    endDate,
    isFounder,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export function parseFundingRoundRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    date: (f.date as string) ?? null,
    raised: typeof f.raised === "number" ? f.raised : null,
    valuation: typeof f.valuation === "number" ? f.valuation : null,
    instrument: (f.instrument as string) ?? null,
    leadInvestor: (f.lead_investor as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export function parseInvestmentRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    investorId: (f.investor as string) ?? null,
    roundName: (f.round_name as string) ?? null,
    date: (f.date as string) ?? null,
    amount: parseNumericOrRange(f.amount),
    stakeAcquired: parseNumericOrRange(f.stake_acquired),
    instrument: (f.instrument as string) ?? null,
    role: (f.role as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export function parseDilutionStageRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    round: (f.round as string) ?? record.key,
    date: (f.date as string) ?? null,
    foundersPercent: typeof f.foundersPercent === "number" ? f.foundersPercent : 0,
    employeesPercent: typeof f.employeesPercent === "number" ? f.employeesPercent : 0,
    investorsPercent: typeof f.investorsPercent === "number" ? f.investorsPercent : 0,
    valuation: typeof f.valuation === "number" ? f.valuation : undefined,
    notes: (f.notes as string) ?? null,
  };
}

export type ParsedDilutionStageRecord = ReturnType<typeof parseDilutionStageRecord>;

export function parseEquityPositionRecord(record: KBRecordEntry) {
  const f = record.fields;
  return {
    key: record.key,
    holderId: (f.holder as string) ?? null,
    stake: parseNumericOrRange(f.stake),
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
    asOf: "asOf" in record ? (record as { asOf?: string }).asOf : undefined,
  };
}

export function parseBoardSeatRecord(record: KBRecordEntry): Omit<BoardMember, "personName" | "personHref"> {
  const f = record.fields;
  return {
    key: record.key,
    personId: (f.member as string) ?? null,
    role: (f.role as string) ?? null,
    appointed: (f.appointed as string) ?? null,
    departed: (f.departed as string) ?? null,
    appointedBy: (f.appointed_by as string) ?? null,
    source: (f.source as string) ?? null,
  };
}

// ── Resource helpers ─────────────────────────────────────────────────

export interface AuthorRef {
  name: string;
  href: string | null;
}

export interface OrgResourceRow {
  id: string;
  title: string;
  url: string;
  type: string;
  publicationName: string | null;
  credibility: number | null;
  citingPageCount: number;
  publishedDate: string | null;
  authors: AuthorRef[];
}

/** Extract the bare domain (no www) from a URL. Returns null on parse failure. */
function extractDomain(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "").toLowerCase();
  } catch {
    return null;
  }
}

/** Well-known news/media source names that aren't real titles. */
const SOURCE_NAMES = new Set([
  "reuters", "cnbc", "bbc", "nytimes", "the new york times",
  "the washington post", "the guardian", "wired", "techcrunch",
  "the verge", "ars technica", "nature", "science", "arxiv",
  "rand", "fortune", "bloomberg", "the information", "time",
  "the economist", "mit technology review", "financial times",
  "associated press", "ap news", "vox", "politico", "axios",
]);

/**
 * Check if a resource title is generic/useless (e.g. just the org name).
 * Returns true if the title should be replaced or the resource filtered out.
 */
function isGenericTitle(title: string, orgName: string): boolean {
  const t = title.toLowerCase().trim();
  const org = orgName.toLowerCase();
  // Exact org name, or org name with year suffix, or possessive form, or very short fragments
  if (t === org) return true;
  if (new RegExp(`^${org.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\(\\d{4}\\)$`).test(t)) return true;
  if (t === `${org}'s` || t === `${org} acknowledged`) return true;
  if (t.length < 10 && t.startsWith(org.slice(0, 5))) return true;

  // Source-name-only titles ("Reuters", "CNBC", "arXiv")
  if (SOURCE_NAMES.has(t)) return true;

  // Bibliographic format: "Author et al. (YYYY)" or "Author & Author (YYYY)"
  if (/^[A-Z][a-z]+(\s+(et\s+al\.|&\s+[A-Z][a-z]+))\s*\(\d{4}\)\s*$/i.test(title.trim())) return true;

  // Very short fragments that aren't useful (<15 chars, no spaces = likely a slug/version)
  if (t.length < 15 && !t.includes(" ")) return true;

  // Single-word titles or version-like strings ("2.0", "v4", "interpretability")
  if (/^\d[\d.]*$/.test(t)) return true;
  if (/^v\d/i.test(t) && t.length < 10) return true;

  return false;
}

/** Check if a title is a landing/section page rather than a real resource. */
function isSectionPage(title: string, orgName: string): boolean {
  const t = title.toLowerCase().trim();
  const org = orgName.toLowerCase();
  // Standalone generic section words
  const standaloneWords = new Set([
    "careers", "team", "about", "blog", "publications",
    "research", "news", "press", "leadership", "contact", "jobs",
  ]);
  if (standaloneWords.has(t)) return true;
  // Generic section pages: "Org Blog", "Org Research", "About Org", etc.
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

/** Decode common HTML entities in titles. */
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

/** Fix common AI acronym casing from URL-slug-derived titles. */
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

/** Clean up a resource title: strip trailing URL noise, org suffixes, etc. */
function cleanTitle(title: string, orgName: string): string {
  let t = decodeHtmlEntities(title);
  // Strip MDX-escaped dollar signs
  t = t.replace(/\\(\$)/g, "$1");
  // Strip inline citation format: 'Author, "Title" (https://...)' or 'Author, *Title* (https://...)'
  const citationMatch = t.match(/^.{2,50},\s*[*"'](.+?)[*"']\s*\(https?:\/\//);
  if (citationMatch) {
    t = citationMatch[1];
  }
  // Strip " | OrgName (https://...)" suffixes
  t = t.replace(/\s*\|\s*[^|]+\(https?:\/\/[^)]+\)\s*$/, "");
  // Strip " | OrgName" suffix
  const escaped = orgName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  t = t.replace(new RegExp(`\\s*\\|\\s*${escaped}\\s*$`, "i"), "");
  // Strip " - OrgName" suffix
  t = t.replace(new RegExp(`\\s*-\\s*${escaped}\\s*$`, "i"), "");
  // Strip " \ OrgName" suffix (backslash variant)
  t = t.replace(new RegExp(`\\s*\\\\\\s*${escaped}\\s*$`, "i"), "");
  // Strip embedded URL in parens: "Title (https://example.com/...)" → "Title"
  t = t.replace(/\s*\(https?:\/\/[^)]+\)\s*$/, "");
  // Strip trailing " - Source" where Source is a known news outlet
  const trailingSource = t.match(/\s*[-–—]\s*(.+)$/);
  if (trailingSource && SOURCE_NAMES.has(trailingSource[1].toLowerCase().trim())) {
    t = t.slice(0, -trailingSource[0].length);
  }
  // Strip markdown emphasis wrapping: **text** → text, *text* → text
  t = t.replace(/^\*\*(.+)\*\*$/, "$1");
  t = t.replace(/^\*(.+)\*$/, "$1");
  // If the title is a full URL, derive from path
  if (/^https?:\/\//.test(t.trim())) {
    const derived = titleFromUrl(t.trim());
    if (derived) return derived;
  }
  return t.trim();
}

/** Derive a human-readable title from a URL path when the DB title is junk. */
function titleFromUrl(url: string): string | null {
  try {
    const path = new URL(url).pathname.replace(/\/$/, "");
    const lastSegment = path.split("/").filter(Boolean).pop();
    if (!lastSegment) return null;
    // Convert slug to title: "claude-3-model-card" → "Claude 3 Model Card"
    const raw = lastSegment
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return fixAcronymCasing(raw);
  } catch {
    return null;
  }
}

/** Lazy-init: name (lowercase) → person slug for author linking. */
let _personNameIndex: Map<string, string> | null = null;

function getPersonNameIndex(): Map<string, string> {
  if (_personNameIndex) return _personNameIndex;
  _personNameIndex = new Map();
  for (const entity of getKBEntities()) {
    if (entity.type !== "person") continue;
    const slug = getKBEntitySlug(entity.id);
    if (!slug) continue;
    _personNameIndex.set(entity.name.toLowerCase(), slug);
    // Also index aliases
    if (entity.aliases) {
      for (const alias of entity.aliases) {
        _personNameIndex.set(alias.toLowerCase(), slug);
      }
    }
  }
  return _personNameIndex;
}

/** Resolve an author name string to an AuthorRef with optional link. */
export function resolveAuthor(name: string): AuthorRef {
  const slug = getPersonNameIndex().get(name.toLowerCase().trim());
  return { name, href: slug ? `/people/${slug}` : null };
}

/** Convert a Resource to an OrgResourceRow. */
function toOrgResourceRow(r: Resource): OrgResourceRow {
  const publication = getResourcePublication(r);
  const credibility = getResourceCredibility(r);
  const citingPages = getPagesForResource(r.id);
  return {
    id: r.id,
    title: r.title ?? "(untitled)",
    url: r.url,
    type: r.type,
    publicationName: publication?.name ?? null,
    credibility: credibility ?? null,
    citingPageCount: citingPages.length,
    publishedDate: r.published_date ?? null,
    authors: (r.authors ?? []).map(resolveAuthor),
  };
}

/** Check if a resource URL looks like a research/publication path. */
function isResearchUrl(url: string): boolean {
  try {
    const path = new URL(url).pathname.toLowerCase();
    return path.startsWith("/research");
  } catch {
    return false;
  }
}

/**
 * Check if a string looks like a person name (2-3 capitalized words, no other content).
 * Used to filter out person-name-only resource titles that aren't informative.
 */
function isPersonNameOnly(title: string): boolean {
  const parts = title.trim().split(/\s+/);
  if (parts.length < 2 || parts.length > 4) return false;
  return parts.every((p) => /^[A-Z][a-z]+\.?$/.test(p) || /^(de|van|von|al|el|bin|ibn|del|la|di)$/i.test(p));
}

/**
 * Normalize a resource row: fix generic titles, skip untitled.
 * Returns null if the resource should be filtered out.
 */
function normalizeRow(r: Resource, orgName: string): OrgResourceRow | null {
  if (!r.title?.trim()) return null;
  const row = toOrgResourceRow(r);

  // Clean up the title (decode entities, strip URL suffixes)
  row.title = cleanTitle(row.title, orgName);

  // Filter out generic org-name-only titles
  if (isGenericTitle(row.title, orgName)) {
    const derived = titleFromUrl(r.url);
    if (derived) {
      row.title = derived;
    } else {
      return null;
    }
  }

  // Filter out section/landing pages
  if (isSectionPage(row.title, orgName)) return null;

  // If the title still looks like a raw URL path (contains domain), derive from URL
  if (row.title.includes("://") || /^[a-z0-9-]+\.\w{2,}\//.test(row.title)) {
    const derived = titleFromUrl(r.url);
    if (derived) row.title = derived;
  }

  // Person-name-only titles → try URL-derived fallback
  if (isPersonNameOnly(row.title)) {
    const derived = titleFromUrl(r.url);
    if (derived && !isPersonNameOnly(derived)) {
      row.title = derived;
    } else {
      return null;
    }
  }

  // Short titles (<20 chars) with no spaces are likely slugs — try URL fallback
  if (row.title.length < 20 && !row.title.includes(" ")) {
    const derived = titleFromUrl(r.url);
    if (derived && derived.length > row.title.length) {
      row.title = derived;
    }
  }

  // Override type: research URLs should display as "paper" not "web"
  if (row.type === "web" && isResearchUrl(r.url)) {
    row.type = "paper";
  }

  return row;
}

/**
 * Get resources split into three categories:
 *  - publications: research papers / technical content by the org
 *  - announcements: news, blog posts, and other org content
 *  - aboutOrg: external resources cited on the org's wiki page
 */
function getOrgResources(
  orgSlug: string,
  orgName: string,
  websiteUrl: string | null,
): {
  publications: OrgResourceRow[];
  announcements: OrgResourceRow[];
  aboutOrg: OrgResourceRow[];
} {
  const allResources = getAllResources();

  // Determine the org's domain(s) for matching
  const orgDomains = new Set<string>();
  if (websiteUrl) {
    const d = extractDomain(websiteUrl);
    if (d) orgDomains.add(d);
  }

  // Split org resources into publications vs announcements
  const publicationsMap = new Map<string, OrgResourceRow>();
  const announcementsMap = new Map<string, OrgResourceRow>();
  const allOrgIds = new Set<string>();
  // Track URLs and titles to deduplicate entries
  const seenUrls = new Set<string>();
  const seenTitles = new Set<string>();

  if (orgDomains.size > 0) {
    for (const r of allResources) {
      const rDomain = extractDomain(r.url);
      if (!rDomain || !orgDomains.has(rDomain)) continue;
      const row = normalizeRow(r, orgName);
      if (!row) continue;

      // Deduplicate by normalized URL (strip trailing slash + fragment)
      const normUrl = r.url.replace(/[#?].*$/, "").replace(/\/$/, "").toLowerCase();
      if (seenUrls.has(normUrl)) continue;
      seenUrls.add(normUrl);

      // Deduplicate by title (case-insensitive) — keep first seen
      const normTitle = row.title.toLowerCase().trim();
      if (seenTitles.has(normTitle)) continue;
      seenTitles.add(normTitle);

      allOrgIds.add(r.id);

      if (isResearchUrl(r.url) || r.type === "paper") {
        publicationsMap.set(r.id, row);
      } else {
        announcementsMap.set(r.id, row);
      }
    }
  }

  // Resources cited on the org's wiki page (ABOUT the org, external only)
  const pageResourceIds = getResourcesForPage(orgSlug);
  const aboutOrgMap = new Map<string, OrgResourceRow>();
  for (const rid of pageResourceIds) {
    if (allOrgIds.has(rid)) continue;
    const r = getResourceById(rid);
    if (!r) continue;
    const row = normalizeRow(r, orgName);
    if (!row) continue;
    aboutOrgMap.set(rid, row);
  }

  // Sort all by date (newest first), dateless items last, then by title
  const sortByDate = (a: OrgResourceRow, b: OrgResourceRow) => {
    const da = a.publishedDate;
    const db = b.publishedDate;
    if (da && !db) return -1;
    if (!da && db) return 1;
    if (da && db && da !== db) return db.localeCompare(da);
    return (a.title ?? "").localeCompare(b.title ?? "");
  };

  return {
    publications: [...publicationsMap.values()].sort(sortByDate),
    announcements: [...announcementsMap.values()].sort(sortByDate),
    aboutOrg: [...aboutOrgMap.values()].sort(sortByDate),
  };
}

// ── Main data loader ─────────────────────────────────────────────────

export interface OrgEntity {
  id: string;
  name: string;
  numericId?: string;
  wikiPageId?: string;
  aliases?: string[];
}

/**
 * Load all data needed for an organization profile page.
 * This is a pure data function — no JSX rendering.
 */
export function loadOrgPageData(entity: OrgEntity, slug: string) {
  // Use URL slug directly — typed entities are keyed by slug, not KB internal IDs
  const typedEntity = getTypedEntityById(slug);
  const orgData = typedEntity && isOrganization(typedEntity) ? typedEntity : null;
  const orgType = orgData?.orgType ?? null;

  // Header facts (description/website come from entity YAML, not KB facts)
  const hqFact = getKBLatest(entity.id, "headquarters");

  // All record collections
  const allCollections = getKBAllRecordCollections(entity.id);

  // Curated collections
  const rawFundingRounds = allCollections["funding-rounds"] ?? [];
  const keyPersons = allCollections["key-persons"] ?? [];
  const investments = allCollections["investments"] ?? [];
  const products = allCollections["products"] ?? [];
  const modelReleases = allCollections["model-releases"] ?? [];
  const safetyMilestones = allCollections["safety-milestones"] ?? [];
  const strategicPartnerships = allCollections["strategic-partnerships"] ?? [];

  // Other (non-curated) collections with entries
  const otherCollections = Object.entries(allCollections)
    .filter(([name, entries]) => !CURATED_COLLECTIONS.has(name) && entries.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  // All facts for the panel
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  // Sort collections by date (most recent first)
  const sortedRounds = sortKBRecords(rawFundingRounds, "date", false);
  const sortedModels = sortKBRecords(modelReleases, "released", false);
  const sortedMilestones = sortKBRecords(safetyMilestones, "date", false);
  const sortedPartnerships = sortKBRecords(strategicPartnerships, "date", false);

  // Sort key persons: current first, then by start date descending
  const sortedPersons = [...keyPersons].sort((a, b) => {
    const endA = a.fields.end ? 1 : 0;
    const endB = b.fields.end ? 1 : 0;
    if (endA !== endB) return endA - endB;
    const startA = a.fields.start ? String(a.fields.start) : "";
    const startB = b.fields.start ? String(b.fields.start) : "";
    return startB.localeCompare(startA);
  });

  const wikiHref = entity.numericId
    ? `/wiki/${entity.numericId}`
    : entity.wikiPageId
      ? `/wiki/${entity.wikiPageId}`
      : null;

  // Fact sidebar data
  const latestByProp = getLatestFactsByProperty(allFacts);
  const categoryGroups = groupByCategory([...latestByProp.keys()]);

  // Description and website come from typed entity YAML data
  const descriptionText = orgData?.description ?? null;
  const websiteUrl = orgData?.website ?? null;

  // AI models developed by this org
  const orgModels = getTypedEntities()
    .filter(isAiModel)
    .filter((m) => m.developer === slug && m.releaseDate)
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
    .map((m) => ({
      id: m.id,
      title: m.title,
      entityType: m.entityType,
      numericId: m.numericId,
      releaseDate: m.releaseDate ?? null,
      inputPrice: m.inputPrice ?? null,
      outputPrice: m.outputPrice ?? null,
      contextWindow: m.contextWindow ?? null,
      safetyLevel: m.safetyLevel ?? null,
      benchmarks: m.benchmarks?.length ? m.benchmarks : null,
    }));

  // Headquarters text
  const hqText =
    hqFact?.value.type === "text" ? hqFact.value.value : null;

  // ── Grants Made (this org is the funder) ──
  const grantRecords = getKBRecords(entity.id, "grants");
  const grantsMade = grantRecords
    .map(parseGrantRecord)
    .sort((a, b) => numericValue(b.amount) - numericValue(a.amount));

  // ── Funding Received (this org is a recipient in other orgs' grants) ──
  const allGrantRecords = getAllKBRecords("grants");
  const recipientMatchNames = new Set<string>([
    entity.name.toLowerCase(),
    slug.toLowerCase(),
    entity.id.toLowerCase(),
    ...(entity.aliases?.map((a) => a.toLowerCase()) ?? []),
  ]);
  const grantsReceived: ReceivedGrant[] = allGrantRecords
    .filter((r) => {
      const recipientRaw = r.fields.recipient as string | undefined;
      if (!recipientRaw) return false;
      return recipientMatchNames.has(recipientRaw.toLowerCase());
    })
    .map((r) => {
      const parsed = parseGrantRecord(r);
      const funderEntity = getKBEntity(r.ownerEntityId);
      const funderSlug = funderEntity ? getKBEntitySlug(r.ownerEntityId) : null;
      return {
        ...parsed,
        funderName: funderEntity?.name ?? r.ownerEntityId,
        funderHref: funderSlug ? `/organizations/${funderSlug}` : null,
      };
    })
    .sort((a, b) => numericValue(b.amount) - numericValue(a.amount));

  // ── Divisions (org subdivisions) ──
  const divisionRecords = getKBRecords(entity.id, "divisions");
  // Deduplicate divisions by name — merge fields from all copies so that
  // metadata (lead, website) and program connections (via key) are both preserved.
  const divisionsByName = new Map<string, ReturnType<typeof parseDivisionRecord>>();
  const divisionAltKeys = new Map<string, Set<string>>(); // name → all keys for this division
  for (const r of divisionRecords) {
    const parsed = parseDivisionRecord(r);
    const existing = divisionsByName.get(parsed.name);
    if (!existing) {
      divisionsByName.set(parsed.name, parsed);
      divisionAltKeys.set(parsed.name, new Set([parsed.key]));
    } else {
      // Merge: fill in any null fields from the new copy
      divisionAltKeys.get(parsed.name)!.add(parsed.key);
      for (const field of ["lead", "status", "startDate", "endDate", "slug", "website", "source"] as const) {
        if (!existing[field] && parsed[field]) {
          (existing as Record<string, unknown>)[field] = parsed[field];
        }
      }
    }
  }
  const divisions = [...divisionsByName.values()]
    .map((parsed) => {
      // Resolve lead slug/stableId to human-readable name
      if (parsed.lead) {
        // Try KB entity resolution first (handles both slugs and stableIds)
        const entityId = resolveKBSlug(parsed.lead);
        const leadEntity = entityId ? getKBEntity(entityId) : getKBEntity(parsed.lead);
        parsed.lead = leadEntity?.name ?? titleCase(parsed.lead.replace(/-/g, " "));
      }
      return parsed;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Dilution Stages ──
  const dilutionStageRecords = getKBRecords(entity.id, "dilution-stages");
  const dilutionStages = dilutionStageRecords
    .map(parseDilutionStageRecord)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  // ── Funding Programs (RFPs, grant rounds, fellowships, etc.) ──
  const fundingProgramRecords = getKBRecords(entity.id, "funding-programs");
  const fundingPrograms = fundingProgramRecords
    .map(parseFundingProgramRecord)
    .sort((a, b) => (b.totalBudget ?? 0) - (a.totalBudget ?? 0));

  // ── Key Personnel (key-person, board, career records owned by this org) ──
  const personnelRecords = getKBRecords(entity.id, "personnel");
  const personnel: ParsedPersonnelRecord[] = personnelRecords
    .map((r) => {
      const parsed = parsePersonnelRecord(r);
      const resolved = parsed.personId
        ? resolveRecipient(parsed.personId)
        : { name: titleCase(r.key.replace(/-/g, " ")), href: null };
      return {
        ...parsed,
        personName: resolved.name,
        personHref: resolved.href,
      };
    })
    .sort((a, b) => {
      if (a.isFounder !== b.isFounder) return a.isFounder ? -1 : 1;
      const typeOrder: Record<string, number> = { "key-person": 0, board: 1, career: 2 };
      const aOrder = typeOrder[a.roleType] ?? 3;
      const bOrder = typeOrder[b.roleType] ?? 3;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.personName.localeCompare(b.personName);
    });

  // ── Funding Rounds ──
  const fundingRoundRecords = getKBRecords(entity.id, "funding-rounds");
  const fundingRounds: ParsedFundingRoundRecord[] = fundingRoundRecords
    .map((r) => {
      const parsed = parseFundingRoundRecord(r);
      const resolved = parsed.leadInvestor
        ? resolveRecipient(parsed.leadInvestor)
        : { name: "", href: null };
      return {
        ...parsed,
        leadInvestorName: resolved.name,
        leadInvestorHref: resolved.href,
      };
    })
    .sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return (b.raised ?? 0) - (a.raised ?? 0);
    });

  // ── Investments Received ──
  const investmentRecords = getKBRecords(entity.id, "investments");
  const investmentsReceived: ParsedInvestmentRecord[] = investmentRecords
    .map((r) => {
      const parsed = parseInvestmentRecord(r);
      const resolved = parsed.investorId
        ? resolveRecipient(parsed.investorId)
        : { name: "", href: null };
      return {
        ...parsed,
        investorName: resolved.name,
        investorHref: resolved.href,
      };
    })
    .sort((a, b) => numericValue(b.amount) - numericValue(a.amount));

  // ── Equity Positions ──
  const equityPositionRecords = getKBRecords(entity.id, "equity-positions");
  const equityPositions: ParsedEquityPositionRecord[] = equityPositionRecords
    .map((r) => {
      const parsed = parseEquityPositionRecord(r);
      const resolved = parsed.holderId
        ? resolveRecipient(parsed.holderId)
        : { name: "", href: null };
      return {
        ...parsed,
        holderName: resolved.name,
        holderHref: resolved.href,
      };
    })
    .sort((a, b) => numericValue(b.stake) - numericValue(a.stake));

  // ── Board of Directors ──
  const boardSeatRecords = allCollections["board-seats"] ?? [];
  const boardMembers: BoardMember[] = boardSeatRecords
    .map((r) => {
      const parsed = parseBoardSeatRecord(r);
      const resolved = parsed.personId
        ? resolveRecipient(parsed.personId)
        : { name: titleCase(r.key.replace(/-/g, " ")), href: null };
      return {
        ...parsed,
        personName: resolved.name,
        personHref: resolved.href,
      };
    })
    .sort((a, b) => {
      const endA = a.departed ? 1 : 0;
      const endB = b.departed ? 1 : 0;
      if (endA !== endB) return endA - endB;
      const sa = a.appointed ?? "";
      const sb = b.appointed ?? "";
      return sb.localeCompare(sa);
    });

  // ── Related Organizations ──
  const relatedOrgs: RelatedOrg[] = [];
  const seenOrgIds = new Set<string>();

  // From strategic partnerships
  for (const sp of strategicPartnerships) {
    const partnerRef = sp.fields.partner != null ? String(sp.fields.partner) : undefined;
    if (!partnerRef) continue;
    const partnerEntityId = resolveKBSlug(partnerRef);
    const partnerEntity = partnerEntityId ? getKBEntity(partnerEntityId) : null;
    if (partnerEntity && partnerEntity.type === "organization" && partnerEntity.id !== entity.id && !seenOrgIds.has(partnerEntity.id)) {
      seenOrgIds.add(partnerEntity.id);
      relatedOrgs.push({
        id: partnerEntity.id,
        name: partnerEntity.name,
        slug: getKBEntitySlug(partnerEntity.id) ?? null,
        relationship: sp.fields.type != null ? String(sp.fields.type) : "Partner",
        date: sp.fields.date != null ? String(sp.fields.date) : null,
      });
    }
  }

  // From grants made — unique recipient orgs (excluding self)
  for (const g of grantsMade) {
    if (!g.recipient) continue;
    const recipEntity = getKBEntity(g.recipient);
    if (recipEntity && recipEntity.type === "organization" && recipEntity.id !== entity.id && !seenOrgIds.has(recipEntity.id)) {
      seenOrgIds.add(recipEntity.id);
      relatedOrgs.push({
        id: recipEntity.id,
        name: recipEntity.name,
        slug: getKBEntitySlug(recipEntity.id) ?? null,
        relationship: "Grantee",
        date: g.date,
      });
    }
  }

  // From grants received — unique funder orgs (excluding self)
  for (const g of grantsReceived) {
    if (!g.funderHref) continue;
    const funderOrgSlug = g.funderHref.replace("/organizations/", "");
    const funderOrgEntityId = resolveKBSlug(funderOrgSlug);
    if (funderOrgEntityId && funderOrgEntityId !== entity.id && !seenOrgIds.has(funderOrgEntityId)) {
      seenOrgIds.add(funderOrgEntityId);
      relatedOrgs.push({
        id: funderOrgEntityId,
        name: g.funderName,
        slug: funderOrgSlug,
        relationship: "Funder",
        date: g.date,
      });
    }
  }

  // ── Founded date + org age ──
  const foundedDateFact = getKBLatest(entity.id, "founded-date");
  const foundedDateStr = foundedDateFact?.value.type === "text" || foundedDateFact?.value.type === "date"
    ? foundedDateFact.value.value
    : foundedDateFact?.value.type === "number"
      ? String(foundedDateFact.value.value)
      : undefined;
  const orgAge = computeOrgAge(foundedDateStr);

  // ── Founded by ──
  const foundedByFact = getKBLatest(entity.id, "founded-by");
  const founders: Array<{ name: string; href: string | null }> = [];
  if (foundedByFact?.value.type === "refs" && Array.isArray(foundedByFact.value.value)) {
    for (const ref of foundedByFact.value.value) {
      const refStr = String(ref);
      const resolved = resolveRecipient(refStr);
      founders.push(resolved);
    }
  } else if (foundedByFact?.value.type === "ref") {
    const resolved = resolveRecipient(foundedByFact.value.value);
    founders.push(resolved);
  }

  // ── Resources ──
  const {
    publications: resourcePublications,
    announcements: resourceAnnouncements,
    aboutOrg: resourcesAboutOrg,
  } = getOrgResources(slug, entity.name, websiteUrl);

  // ── Key Publications (from literature.yaml) ──
  const orgMatchNames = new Set<string>([
    entity.name.toLowerCase(),
    slug.toLowerCase(),
    entity.id.toLowerCase(),
    ...(entity.aliases?.map((a) => a.toLowerCase()) ?? []),
  ]);
  const keyPublications: LiteraturePaper[] = getLiteraturePapers()
    .filter((p) => {
      if (!p.organization) return false;
      return orgMatchNames.has(p.organization.toLowerCase());
    })
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0));

  // ── Model benchmark data ──
  const modelBenchmarks = new Map<string, Array<{ name: string; score: number; unit?: string }>>();
  for (const model of orgModels) {
    if (model.benchmarks && model.benchmarks.length > 0) {
      modelBenchmarks.set(model.id, model.benchmarks);
    }
  }

  // ── Division lead resolution ──
  const divisionLeadResolved = new Map<string, { name: string; href: string | null }>();
  for (const d of divisions) {
    if (d.lead) {
      const leadEntityId = resolveKBSlug(d.lead);
      const leadEntity = leadEntityId ? getKBEntity(leadEntityId) : null;
      if (leadEntity) {
        const leadSlug = getKBEntitySlug(leadEntityId!);
        divisionLeadResolved.set(d.key, {
          name: leadEntity.name,
          href: leadSlug && leadEntity.type === "person" ? `/people/${leadSlug}` : `/kb/entity/${leadEntityId}`,
        });
      } else {
        divisionLeadResolved.set(d.key, { name: d.lead, href: null });
      }
    }
  }

  // ── Division spending stats ──
  // Compute total grant spending per division via: division → funding programs → grants.
  // Uses ALL alternate keys (from merged duplicates) to match funding programs.
  const divisionSpending = new Map<string, { totalAmount: number; grantCount: number }>();
  for (const d of divisions) {
    // All keys for this division (including duplicates that were merged)
    const allKeys = divisionAltKeys.get(d.name) ?? new Set([d.key]);

    // Find programs linked to ANY of this division's keys
    const divPrograms = fundingPrograms.filter((p) => {
      const raw = fundingProgramRecords.find((r) => r.key === p.key);
      if (!raw) return false;
      const divId = raw.fields.divisionId as string;
      return allKeys.has(divId);
    });
    const programKeys = new Set(divPrograms.map((p) => p.key));

    // Find grants matching those programs (or direct division name/key match)
    let totalAmount = 0;
    let grantCount = 0;
    const allKeysLower = new Set([...allKeys].map((k) => k.toLowerCase()));
    for (const g of grantRecords) {
      const programId = g.fields.programId as string | undefined;
      const gDiv = g.fields.divisionName as string | undefined;
      const gProgram = g.fields.program as string | undefined;
      const divName = d.name.toLowerCase();

      const matches =
        (programId && programKeys.has(programId)) ||
        (gDiv && (gDiv.toLowerCase() === divName || allKeysLower.has(gDiv.toLowerCase()))) ||
        (gProgram && allKeysLower.has(gProgram.toLowerCase()));

      if (matches) {
        const amount = typeof g.fields.amount === "number" ? g.fields.amount : 0;
        totalAmount += amount;
        grantCount++;
      }
    }
    if (grantCount > 0) {
      divisionSpending.set(d.key, { totalAmount, grantCount });
    }
  }

  // ── Computed stat cards ──
  const currentKeyPeople = sortedPersons.filter((p) => !p.fields.end).length;
  const currentBoardMembers = boardMembers.filter((m) => !m.departed).length;
  const totalGrantsMade = grantsMade.reduce((sum, g) => sum + numericValue(g.amount), 0);
  const totalGrantsReceived = grantsReceived.reduce((sum, g) => sum + numericValue(g.amount), 0);

  // ── Chart data: time series from KB facts ──
  const chartData = buildChartData(entity.id, sortedRounds, equityPositions);

  return {
    orgType,
    hqText,
    allCollections,
    otherCollections,
    allFacts,
    sortedRounds,
    sortedModels,
    sortedMilestones,
    sortedPartnerships,
    sortedPersons,
    wikiHref,
    latestByProp,
    categoryGroups,
    descriptionText,
    websiteUrl,
    orgModels,
    grantsMade,
    grantsReceived,
    divisions,
    fundingPrograms,
    personnel,
    fundingRounds,
    investmentsReceived,
    equityPositions,
    boardMembers,
    relatedOrgs,
    foundedDateStr,
    orgAge,
    founders,
    currentKeyPeople,
    currentBoardMembers,
    totalGrantsMade,
    totalGrantsReceived,
    investments,
    products,
    resourcePublications,
    resourceAnnouncements,
    resourcesAboutOrg,
    keyPublications,
    modelBenchmarks,
    divisionLeadResolved,
    divisionSpending,
    chartData,
    dilutionStages,
  };
}

// ── Chart data extraction ─────────────────────────────────────────────

/** Extract numeric value from a Fact, handling ranges. */
function factNumericValue(fact: Fact): number | null {
  if (fact.value.type === "number") return fact.value.value;
  if (fact.value.type === "range") return (fact.value.low + fact.value.high) / 2;
  return null;
}

function factRange(fact: Fact): { low?: number; high?: number } {
  if (fact.value.type === "range") return { low: fact.value.low, high: fact.value.high };
  return {};
}

export interface ChartDataBundle {
  /** Valuation over time (from KB facts) */
  valuationSeries: Array<{ date: string; value: number; label?: string }>;
  /** Revenue over time (from KB facts) */
  revenueSeries: Array<{ date: string; value: number; low?: number; high?: number }>;
  /** Headcount over time (from KB facts) */
  headcountSeries: Array<{ date: string; value: number; low?: number; high?: number }>;
  /** Equity holders for breakdown chart */
  equityHolders: Array<{
    name: string;
    stakePercent: number;
    stakeLow?: number;
    stakeHigh?: number;
    color: string;
    href: string | null;
  }>;
  /** Latest valuation for equity value computation */
  latestValuation: number | null;
  /** Funding round annotations for valuation chart */
  fundingAnnotations: Array<{ date: string; label: string; raised?: number; valuation?: number }>;
}

function buildChartData(
  entityId: string,
  sortedRounds: KBRecordEntry[],
  equityPositions: ParsedEquityPositionRecord[],
): ChartDataBundle {
  // Extract fact time series
  const valuationFacts = getKBFacts(entityId, "valuation");
  const revenueFacts = getKBFacts(entityId, "revenue");
  const headcountFacts = getKBFacts(entityId, "headcount");

  const valuationSeries = valuationFacts
    .filter((f) => f.asOf && factNumericValue(f) != null)
    .map((f) => {
      // Try to match to a funding round for label
      const round = sortedRounds.find((r) => {
        const roundDate = r.fields.date ? String(r.fields.date) : "";
        return roundDate && f.asOf && roundDate.startsWith(f.asOf.slice(0, 7));
      });
      const roundName = round ? (round.fields.name ? String(round.fields.name) : titleCase(round.key)) : undefined;
      return { date: f.asOf!, value: factNumericValue(f)!, label: roundName };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  const revenueSeries = revenueFacts
    .filter((f) => f.asOf && factNumericValue(f) != null)
    .map((f) => ({
      date: f.asOf!,
      value: factNumericValue(f)!,
      ...factRange(f),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  const headcountSeries = headcountFacts
    .filter((f) => f.asOf && factNumericValue(f) != null)
    .map((f) => ({
      date: f.asOf!,
      value: factNumericValue(f)!,
      ...factRange(f),
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  // Equity holders with colors
  const EQUITY_COLORS = [
    "#ef4444", "#f59e0b", "#22c55e", "#3b82f6", "#8b5cf6",
    "#ec4899", "#14b8a6", "#f97316", "#6366f1", "#64748b",
    "#a855f7", "#06b6d4",
  ];

  const equityHolders = equityPositions
    .filter((p) => p.holderName && numericValue(p.stake) > 0)
    .map((p, i) => {
      const midpoint = numericValue(p.stake);
      const isRange = Array.isArray(p.stake);
      return {
        name: p.holderName,
        stakePercent: midpoint * 100,
        stakeLow: isRange ? (p.stake as [number, number])[0] * 100 : undefined,
        stakeHigh: isRange ? (p.stake as [number, number])[1] * 100 : undefined,
        href: p.holderHref,
      };
    });

  // Assign colors after sorting
  equityHolders.sort((a, b) => b.stakePercent - a.stakePercent);
  const coloredEquity = equityHolders.map((h, i) => ({
    ...h,
    color: EQUITY_COLORS[i % EQUITY_COLORS.length],
  }));

  const latestValuation = valuationSeries.length > 0
    ? valuationSeries[valuationSeries.length - 1].value
    : null;

  // Funding round annotations
  const fundingAnnotations = sortedRounds
    .filter((r) => r.fields.date)
    .map((r) => ({
      date: String(r.fields.date),
      label: r.fields.name ? String(r.fields.name) : titleCase(r.key),
      raised: typeof r.fields.raised === "number" ? r.fields.raised : undefined,
      valuation: typeof r.fields.valuation === "number" ? r.fields.valuation : undefined,
    }))
    .sort((a, b) => a.date.localeCompare(b.date));

  return {
    valuationSeries,
    revenueSeries,
    headcountSeries,
    equityHolders: coloredEquity,
    latestValuation,
    fundingAnnotations,
  };
}
