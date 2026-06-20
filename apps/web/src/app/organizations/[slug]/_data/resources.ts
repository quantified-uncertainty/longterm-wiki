import {
  getTypedEntities,
  getTypedEntityByStableId,
  isOrganization,
  isPerson,
  resolveResource,
  getResourceCredibility,
  getResourcePublication,
  getPagesForResource,
  getEntityResourceLinks,
  type Resource,
} from "@/data";
import { getKBEntities, getKBEntitySlug } from "@/data/factbase";
import { extractDomain, extractDateFromUrl } from "@/lib/resource-types";
import type { AuthorRef } from "./common";

export interface OrgResourceRow {
  id: string;
  title: string;
  url: string;
  type: string;
  domain: string | null;
  publicationName: string | null;
  credibility: number | null;
  citingPageCount: number;
  publishedDate: string | null;
  authors: AuthorRef[];
  summary: string | null;
  abstract: string | null;
  keyPoints: string[] | null;
  fetchStatus: string | null;
  archiveUrl: string | null;
  stance: string | null;
}

// extractDomain is imported from @/lib/resource-types

/** Well-known news/media source names that aren't real titles. */
const SOURCE_NAMES = new Set([
  "reuters", "cnbc", "bbc", "nytimes", "the new york times",
  "the washington post", "the guardian", "wired", "techcrunch",
  "the verge", "ars technica", "nature", "science", "arxiv",
  "rand", "fortune", "bloomberg", "the information", "time",
  "the economist", "mit technology review", "financial times",
  "associated press", "ap news", "vox", "politico", "axios",
  "twitter", "x/twitter", "twitter/x", "facebook", "linkedin",
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
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    // Decode &amp; LAST so inputs like &amp;lt; round-trip to the literal
    // &lt; instead of being double-unescaped to <.
    .replace(/&amp;/g, "&");
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
    // Pure-numeric segments are IDs (e.g., tweet status IDs), not titles
    if (/^\d+$/.test(lastSegment)) return null;
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
  // Primary: index from TableBase typed entities
  for (const entity of getTypedEntities()) {
    if (!isPerson(entity)) continue;
    _personNameIndex.set(entity.title.toLowerCase(), entity.id);
  }
  // Also include FactBase entities for aliases (TableBase doesn't have aliases)
  for (const entity of getKBEntities()) {
    if (entity.type !== "person") continue;
    const slug = getKBEntitySlug(entity.id);
    if (!slug) continue;
    // Don't overwrite TableBase entries, just fill in missing names
    if (!_personNameIndex.has(entity.name.toLowerCase())) {
      _personNameIndex.set(entity.name.toLowerCase(), slug);
    }
    if (entity.aliases) {
      for (const alias of entity.aliases) {
        if (!_personNameIndex.has(alias.toLowerCase())) {
          _personNameIndex.set(alias.toLowerCase(), slug);
        }
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

/**
 * Resolve an author by entity stable ID. Returns an AuthorRef with href
 * if the stable ID maps to a person entity, otherwise returns null.
 */
function resolveAuthorByEntityId(stableId: string, name: string): AuthorRef | null {
  const entity = getTypedEntityByStableId(stableId);
  if (!entity) return null;
  if (isPerson(entity)) {
    return { name, href: `/people/${entity.id}` };
  }
  // Non-person entities (e.g., organizations) — still link if they have a directory page
  if (isOrganization(entity)) {
    return { name, href: `/organizations/${entity.id}` };
  }
  return null;
}

/**
 * Resolve authors for a resource, preferring entity stable IDs when available.
 * Falls back to name-based matching for authors without a matching entity ID.
 */
export function resolveResourceAuthors(r: Resource): AuthorRef[] {
  const authors = r.authors ?? [];
  const entityIds = r.author_entity_ids;
  // author_entity_ids is positional (same order as authors) only when ALL authors
  // matched an entity. The producer (crux link-resources) skips unmatched authors,
  // so a length mismatch means some authors are missing — fall back entirely.
  const hasParallelIds =
    entityIds != null &&
    entityIds.length === authors.length;

  return authors.map((name, i) => {
    // Try entity-ID-based resolution first (more accurate)
    if (hasParallelIds && entityIds[i]) {
      const ref = resolveAuthorByEntityId(entityIds[i], name);
      if (ref) return ref;
    }
    // Fall back to name-based resolution
    return resolveAuthor(name);
  });
}

/** Convert a Resource to an OrgResourceRow. */
function toOrgResourceRow(r: Resource): OrgResourceRow {
  const publication = getResourcePublication(r);
  const domain = extractDomain(r.url);
  const credibility = getResourceCredibility(r) ?? null;
  const citingPages = getPagesForResource(r.id);
  return {
    id: r.id,
    title: r.title ?? "(untitled)",
    url: r.url,
    type: r.type,
    domain,
    publicationName: publication?.name ?? null,
    credibility,
    citingPageCount: citingPages.length,
    publishedDate: r.published_date ?? extractDateFromUrl(r.url) ?? null,
    authors: resolveResourceAuthors(r),
    summary: r.summary ?? null,
    abstract: r.abstract ?? null,
    keyPoints: r.key_points?.length ? r.key_points : null,
    fetchStatus: r.fetch_status ?? null,
    archiveUrl: r.archive_url ?? null,
    stance: r.stance ?? null,
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
export function getOrgResources(
  orgName: string,
  entityStableId?: string,
): {
  publications: OrgResourceRow[];
  announcements: OrgResourceRow[];
  aboutOrg: OrgResourceRow[];
} {
  if (entityStableId) {
    const links = getEntityResourceLinks(entityStableId);
    if (links && (links.authored.length > 0 || links.subject.length > 0)) {
      return getOrgResourcesFromLinks(links, orgName);
    }
  }

  // Entity not in entity_resources — return empty
  return { publications: [], announcements: [], aboutOrg: [] };
}

/** Use entity_resources links to split resources into publications/announcements/press */
function getOrgResourcesFromLinks(
  links: { authored: string[]; subject: string[] },
  orgName: string,
): {
  publications: OrgResourceRow[];
  announcements: OrgResourceRow[];
  aboutOrg: OrgResourceRow[];
} {
  const authoredSet = new Set(links.authored);
  const publications: OrgResourceRow[] = [];
  const announcements: OrgResourceRow[] = [];
  const aboutOrg: OrgResourceRow[] = [];
  const RESEARCH_PUB_TYPES = new Set(["preprint_server", "academic_journal", "think_tank", "academic"]);

  // Authored resources → split into publications vs announcements by publication type.
  // resolveResource() handles both legacy hex16 and sid_ keyspace — links.authored
  // values were hex16 before QUA-567 and are sid_ after.
  for (const rid of links.authored) {
    const r = resolveResource(rid);
    if (!r) continue;
    const row = normalizeRow(r, orgName);
    if (!row) continue;

    const pub = getResourcePublication(r);
    const isResearch = (pub?.type && RESEARCH_PUB_TYPES.has(pub.type))
      || r.type === "paper" || isResearchUrl(r.url);
    if (isResearch) {
      publications.push(row);
    } else {
      announcements.push(row);
    }
  }

  // Subject resources (not also authored) → press/coverage
  for (const rid of links.subject) {
    if (authoredSet.has(rid)) continue;
    const r = resolveResource(rid);
    if (!r) continue;
    const row = normalizeRow(r, orgName);
    if (!row) continue;
    aboutOrg.push(row);
  }

  const sortByDate = (a: OrgResourceRow, b: OrgResourceRow) => {
    const da = a.publishedDate;
    const db = b.publishedDate;
    if (da && !db) return -1;
    if (!da && db) return 1;
    if (da && db && da !== db) return db.localeCompare(da);
    return (a.title ?? "").localeCompare(b.title ?? "");
  };

  return {
    publications: publications.sort(sortByDate),
    announcements: announcements.sort(sortByDate),
    aboutOrg: aboutOrg.sort(sortByDate),
  };
}
