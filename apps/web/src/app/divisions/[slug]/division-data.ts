/**
 * Data-fetching, parsing, and type definitions for division detail pages.
 * Extracted from page.tsx as a pure refactor — no behavioral changes.
 */
import {
  getAllKBRecords,
  getKBEntitySlug,
  getKBRecords,
} from "@/data/factbase";
import type { KBRecordEntry } from "@/data/factbase";
import { getTypedEntityById } from "@/data/tablebase";
import { resolveEntityName } from "@/lib/resolve-entity-name";

// ── Types ──────────────────────────────────────────────────────────────

export interface ParsedDivision {
  key: string;
  ownerEntityId: string;
  name: string;
  slug: string | null;
  divisionType: string;
  lead: string | null;
  status: string | null;
  startDate: string | null;
  endDate: string | null;
  website: string | null;
  source: string | null;
  notes: string | null;
}

export interface ParsedFundingProgram {
  key: string;
  name: string;
  programType: string;
  description: string | null;
  totalBudget: number | null;
  status: string | null;
  deadline: string | null;
  openDate: string | null;
}

export interface ParsedDivisionGrant {
  key: string;
  name: string;
  recipientName: string;
  recipientHref: string | null;
  amount: number | null;
  date: string | null;
  status: string | null;
}

export interface DivisionRecipient {
  name: string;
  href: string | null;
  grantCount: number;
  totalAmount: number;
}

export interface ParsedDivisionPersonnel {
  key: string;
  personId: string;
  personName: string;
  personHref: string | null;
  role: string;
  startDate: string | null;
  endDate: string | null;
  source: string | null;
  notes: string | null;
}

// ── Resolution helpers ─────────────────────────────────────────────────

/** @deprecated Use resolveEntityName from @/lib/resolve-entity-name */
export function resolveEntityLink(entityId: string, displayName?: string | null): { name: string; href: string | null } {
  return resolveEntityName(entityId, displayName);
}

// ── Record parsers ────────────────────────────────────────────────────

export function parseDivision(record: KBRecordEntry): ParsedDivision {
  const f = record.fields;
  return {
    key: record.key,
    ownerEntityId: record.ownerEntityId,
    name: (f.name as string) ?? record.key,
    slug: (f.slug as string) ?? null,
    divisionType: (f.divisionType as string) ?? "team",
    lead: (f.lead as string) ?? null,
    status: (f.status as string) ?? null,
    startDate: (f.startDate as string) ?? null,
    endDate: (f.endDate as string) ?? null,
    website: (f.website as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export function parseFundingProgram(record: KBRecordEntry): ParsedFundingProgram {
  const f = record.fields;
  return {
    key: record.key,
    name: (f.name as string) ?? record.key,
    programType: (f.programType as string) ?? "grant-round",
    description: (f.description as string) ?? null,
    totalBudget: typeof f.totalBudget === "number" ? f.totalBudget : null,
    status: (f.status as string) ?? null,
    deadline: (f.deadline as string) ?? null,
    openDate: (f.openDate as string) ?? null,
  };
}

export function parseDivisionPersonnel(record: KBRecordEntry): ParsedDivisionPersonnel {
  const f = record.fields;
  const personId = (f.personId as string) ?? "";
  const person = personId ? resolveEntityLink(personId, record.displayName) : { name: personId, href: null };

  return {
    key: record.key,
    personId,
    personName: person.name,
    personHref: person.href,
    role: (f.role as string) ?? "",
    startDate: (f.startDate as string) ?? null,
    endDate: (f.endDate as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

// ── Slug helpers ─────────────────────────────────────────────────────

/** Get the org slug for a division's ownerEntityId. */
function getOrgSlugForEntity(entityId: string): string | null {
  return getKBEntitySlug(entityId) ?? null;
}

/**
 * Derive a URL-safe slug from a division name.
 * E.g. "Alignment Science" → "alignment-science"
 */
function nameToSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** Build the canonical href for a division: /organizations/[orgSlug]/divisions/[divSlug] */
export function getDivisionHref(division: { key: string; slug?: string | null; name?: string; ownerEntityId: string }): string | null {
  const orgSlug = getOrgSlugForEntity(division.ownerEntityId);
  if (!orgSlug) return null;
  // Prefer explicit slug, then name-derived slug, then opaque key as fallback
  const divSlug = division.slug || (division.name ? nameToSlug(division.name) : null) || division.key;
  return `/organizations/${orgSlug}/divisions/${divSlug}`;
}

// ── Deduplication ────────────────────────────────────────────────────

/**
 * Deduplicate division records by name within each owner entity.
 * Merges fields from all copies so metadata (lead, website) and
 * program connections (via different keys) are both preserved.
 * Returns merged records and a map of all alternate keys per division.
 */
function deduplicateDivisions(divisions: KBRecordEntry[]): {
  records: KBRecordEntry[];
  altKeys: Map<string, Set<string>>;
} {
  const byOwnerAndName = new Map<string, KBRecordEntry>();
  const altKeys = new Map<string, Set<string>>(); // mapKey → all record keys
  for (const d of divisions) {
    const name = (d.fields.name as string) ?? d.key;
    const mapKey = `${d.ownerEntityId}::${name}`;
    const existing = byOwnerAndName.get(mapKey);
    if (!existing) {
      // Clone to avoid mutating the shared cache from getAllKBRecords()
      byOwnerAndName.set(mapKey, { ...d, fields: { ...d.fields } });
      altKeys.set(mapKey, new Set([d.key]));
    } else {
      altKeys.get(mapKey)!.add(d.key);
      // Merge: fill in any null/missing fields from the new copy into existing
      for (const field of ["lead", "status", "startDate", "endDate", "slug", "website", "source", "notes"] as const) {
        if (!existing.fields[field] && d.fields[field]) {
          existing.fields[field] = d.fields[field];
        }
      }
    }
  }

  // Build a lookup from the winning record's key to all alt keys
  const keyToAltKeys = new Map<string, Set<string>>();
  for (const [, record] of byOwnerAndName) {
    const name = (record.fields.name as string) ?? record.key;
    const mapKey = `${record.ownerEntityId}::${name}`;
    const keys = altKeys.get(mapKey);
    if (keys) {
      keyToAltKeys.set(record.key, keys);
    }
  }

  return { records: [...byOwnerAndName.values()], altKeys: keyToAltKeys };
}

/**
 * Get all alternate keys for a division record (from merged duplicates).
 * Falls back to searching all divisions for same-name matches.
 */
export function getDivisionAltKeys(record: KBRecordEntry): Set<string> {
  const allDivisions = getAllKBRecords("divisions");
  const name = (record.fields.name as string) ?? record.key;
  const keys = new Set<string>();
  for (const d of allDivisions) {
    if (d.ownerEntityId !== record.ownerEntityId) continue;
    const dName = (d.fields.name as string) ?? d.key;
    if (dName === name) keys.add(d.key);
  }
  return keys;
}

// ── Lookup helpers ────────────────────────────────────────────────────

/**
 * Find a division by org slug + division identifier.
 * Matches by: record key, fields.slug, or name-derived slug.
 * Returns merged record.
 */
export function findDivision(orgSlug: string, divId: string): KBRecordEntry | undefined {
  const allDivisions = getAllKBRecords("divisions");
  const match = allDivisions.find((d) => {
    const ownerOrgSlug = getOrgSlugForEntity(d.ownerEntityId);
    if (ownerOrgSlug !== orgSlug) return false;
    // Match by key, explicit slug, or name-derived slug
    if (d.key === divId) return true;
    const fieldSlug = d.fields.slug as string | undefined;
    if (fieldSlug === divId) return true;
    const divName = (d.fields.name as string) ?? '';
    if (divName && nameToSlug(divName) === divId) return true;
    return false;
  });
  if (!match) return undefined;

  // Clone to avoid mutating the shared cache from getAllKBRecords()
  const result: KBRecordEntry = { ...match, fields: { ...match.fields } };

  // If this division has duplicates, merge fields from all copies
  const name = (result.fields.name as string) ?? result.key;
  for (const d of allDivisions) {
    if (d.key === result.key) continue;
    if (d.ownerEntityId !== result.ownerEntityId) continue;
    const dName = (d.fields.name as string) ?? d.key;
    if (dName !== name) continue;
    // Merge missing fields from the duplicate
    for (const field of ["lead", "status", "startDate", "endDate", "slug", "website", "source", "notes"]) {
      if (!result.fields[field] && d.fields[field]) {
        result.fields[field] = d.fields[field];
      }
    }
  }
  return result;
}

/** Legacy: find by old-style slug (key, fields.slug, or name-derived slug). Used for redirects. */
export function findDivisionByLegacySlug(slug: string): KBRecordEntry | undefined {
  const allDivisions = getAllKBRecords("divisions");
  return allDivisions.find((d) => {
    const divSlug = d.fields.slug as string | undefined;
    if (divSlug === slug || d.key === slug) return true;
    const divName = (d.fields.name as string) ?? '';
    return divName && nameToSlug(divName) === slug;
  });
}

/** Get all {slug, divSlug} pairs for static generation. Deduplicates by name. */
export function getAllDivisionParams(): Array<{ slug: string; divSlug: string }> {
  const { records } = deduplicateDivisions(getAllKBRecords("divisions"));
  const params: Array<{ slug: string; divSlug: string }> = [];
  for (const d of records) {
    const orgSlug = getOrgSlugForEntity(d.ownerEntityId);
    if (!orgSlug) continue;
    const parsed = parseDivision(d);
    const divSlug = parsed.slug || nameToSlug(parsed.name) || d.key;
    params.push({ slug: orgSlug, divSlug });
  }
  return params;
}

/** @deprecated Use findDivision(orgSlug, divSlug) instead. */
export function findDivisionBySlug(slug: string): KBRecordEntry | undefined {
  return findDivisionByLegacySlug(slug);
}

/** @deprecated Use getAllDivisionParams() instead. */
export function getAllDivisionSlugs(): string[] {
  const allDivisions = getAllKBRecords("divisions");
  const slugs: string[] = [];
  for (const d of allDivisions) {
    const slug = d.fields.slug as string | undefined;
    if (slug) {
      slugs.push(slug);
    } else {
      slugs.push(d.key);
    }
  }
  return slugs;
}

// ── Status / type labels & colors ──────────────────────────────────────
// Shared constants live in division-constants.ts; re-exported here for backwards compatibility.

export {
  DIVISION_TYPE_LABELS,
  DIVISION_TYPE_COLORS,
  STATUS_COLORS,
} from "../division-constants";

export const PROGRAM_TYPE_LABELS: Record<string, string> = {
  rfp: "RFP",
  "grant-round": "Grant Round",
  fellowship: "Fellowship",
  prize: "Prize",
  solicitation: "Solicitation",
  call: "Call",
  fund: "Fund",
  program: "Program",
  initiative: "Initiative",
  round: "Round",
  "big-bet": "Big Bet",
  commitment: "Commitment",
};

export const PROGRAM_TYPE_COLORS: Record<string, string> = {
  rfp: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
  "grant-round": "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  fellowship: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  prize: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  solicitation: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
  call: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
  fund: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
  program: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
  initiative: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  round: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  "big-bet": "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  commitment: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
};

// ── Main data loader ─────────────────────────────────────────────────

export interface SiblingDivision {
  key: string;
  name: string;
  divisionType: string;
  status: string | null;
  href: string | null;
}

export interface DivisionPageData {
  division: ParsedDivision;
  parent: { name: string; href: string | null };
  parentWikiPageId: string | null;
  leadName: string | null;
  leadHref: string | null;
  personnel: ParsedDivisionPersonnel[];
  divisionPrograms: ParsedFundingProgram[];
  grants: ParsedDivisionGrant[];
  recipients: DivisionRecipient[];
  siblingDivisions: SiblingDivision[];
}

export function loadDivisionPageData(record: import("@/data/factbase").KBRecordEntry): DivisionPageData {
  const division = parseDivision(record);
  const parent = resolveEntityLink(division.ownerEntityId);

  // Get all alternate keys for this division (handles merged duplicates)
  const allDivKeys = getDivisionAltKeys(record);

  // Resolve lead if present (may be a person entity ID or a plain name)
  let leadName: string | null = null;
  let leadHref: string | null = null;
  if (division.lead) {
    const resolved = resolveEntityLink(division.lead);
    leadName = resolved.name;
    leadHref = resolved.href;
  }

  // Find funding programs linked to ANY of this division's keys
  const allPrograms = getAllKBRecords("funding-programs");
  const divisionPrograms = allPrograms
    .filter((p) => {
      const divId = p.fields.divisionId;
      return typeof divId === "string" && allDivKeys.has(divId);
    })
    .map(parseFundingProgram)
    .sort((a, b) => (b.totalBudget ?? 0) - (a.totalBudget ?? 0));

  // Find division personnel (check all alternate keys)
  const personnelRecords: import("@/data/factbase").KBRecordEntry[] = [];
  for (const key of allDivKeys) {
    personnelRecords.push(...getKBRecords(`__division__${key}`, "division-personnel"));
  }
  const personnel = personnelRecords
    .map(parseDivisionPersonnel)
    .sort((a, b) => a.personName.localeCompare(b.personName));

  // Parent wiki page link
  const parentTypedEntity = getTypedEntityById(division.ownerEntityId);
  const parentWikiPageId = parentTypedEntity?.wikiId ?? null;

  // Find grants associated with this division via: grant.programId → funding-program.divisionId → division keys
  const programKeysForDivision = new Set(
    divisionPrograms.map((p) => p.key),
  );
  const parentGrants = getKBRecords(division.ownerEntityId, "grants");
  const allDivKeysLower = new Set([...allDivKeys].map((k) => k.toLowerCase()));
  const grants: ParsedDivisionGrant[] = parentGrants
    .filter((g) => {
      const programId = g.fields.programId as string | undefined;
      if (programId && programKeysForDivision.has(programId)) return true;
      // Fallback: direct divisionName/program match
      const gDiv = g.fields.divisionName as string | undefined;
      const gProgram = g.fields.program as string | undefined;
      const divisionName = division.name.toLowerCase();
      if (gDiv) {
        if (gDiv.toLowerCase() === divisionName || allDivKeysLower.has(gDiv.toLowerCase())) return true;
      }
      if (gProgram && allDivKeysLower.has(gProgram.toLowerCase())) return true;
      return false;
    })
    .map((g) => {
      const recipientId = g.fields.recipient as string | undefined;
      const resolved = recipientId ? resolveEntityLink(recipientId) : { name: "", href: null };
      const amount = typeof g.fields.amount === "number" ? g.fields.amount : null;
      return {
        key: g.key,
        name: (g.fields.name as string) ?? g.key,
        recipientName: resolved.name,
        recipientHref: resolved.href,
        amount,
        date: (g.fields.date as string) ?? (g.fields.period as string) ?? null,
        status: (g.fields.status as string) ?? null,
      };
    })
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  // Aggregate unique recipients from grants
  const recipientMap = new Map<string, DivisionRecipient>();
  for (const g of grants) {
    if (!g.recipientName) continue;
    const existing = recipientMap.get(g.recipientName);
    if (existing) {
      existing.grantCount++;
      existing.totalAmount += g.amount ?? 0;
    } else {
      recipientMap.set(g.recipientName, {
        name: g.recipientName,
        href: g.recipientHref,
        grantCount: 1,
        totalAmount: g.amount ?? 0,
      });
    }
  }
  const recipients = [...recipientMap.values()]
    .sort((a, b) => b.totalAmount - a.totalAmount);

  // Find sibling divisions (other divisions in the same org, excluding current)
  const allDivisions = getAllKBRecords("divisions");
  const currentName = division.name;
  const seenNames = new Set<string>([currentName]);
  const siblingDivisions: SiblingDivision[] = [];
  for (const d of allDivisions) {
    if (d.ownerEntityId !== division.ownerEntityId) continue;
    const name = (d.fields.name as string) ?? d.key;
    if (seenNames.has(name)) continue;
    seenNames.add(name);
    const parsed = parseDivision(d);
    siblingDivisions.push({
      key: d.key,
      name: parsed.name,
      divisionType: parsed.divisionType,
      status: parsed.status,
      href: getDivisionHref(parsed),
    });
  }
  siblingDivisions.sort((a, b) => a.name.localeCompare(b.name));

  return {
    division,
    parent,
    parentWikiPageId,
    leadName,
    leadHref,
    personnel,
    divisionPrograms,
    grants,
    recipients,
    siblingDivisions,
  };
}
