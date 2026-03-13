/**
 * Data-fetching, parsing, and type definitions for division detail pages.
 * Extracted from page.tsx as a pure refactor — no behavioral changes.
 */
import {
  getAllKBRecords,
  getKBEntity,
  getKBEntitySlug,
  getKBRecords,
} from "@/data/kb";
import type { KBRecordEntry } from "@/data/kb";
import { getTypedEntityById } from "@/data/database";
import {
  titleCase,
} from "@/components/wiki/kb/format";

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

export function resolveEntityLink(entityId: string): { name: string; href: string | null } {
  const entity = getKBEntity(entityId);
  if (entity) {
    const slug = getKBEntitySlug(entityId);
    if (slug) {
      if (entity.type === "organization") return { name: entity.name, href: `/organizations/${slug}` };
      if (entity.type === "person") return { name: entity.name, href: `/people/${slug}` };
    }
    return { name: entity.name, href: `/kb/entity/${entityId}` };
  }
  return { name: titleCase(entityId.replace(/-/g, " ")), href: null };
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
  const person = personId ? resolveEntityLink(personId) : { name: personId, href: null };

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

// ── Lookup helpers ────────────────────────────────────────────────────

export function findDivisionBySlug(slug: string): KBRecordEntry | undefined {
  const allDivisions = getAllKBRecords("divisions");
  return allDivisions.find((d) => {
    const divSlug = d.fields.slug as string | undefined;
    return divSlug === slug || d.key === slug;
  });
}

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

export const DIVISION_TYPE_LABELS: Record<string, string> = {
  fund: "Fund",
  team: "Team",
  department: "Department",
  lab: "Lab",
  "program-area": "Program Area",
};

export const DIVISION_TYPE_COLORS: Record<string, string> = {
  fund: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  team: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  department: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  lab: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "program-area": "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

export const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  inactive: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  dissolved: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

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

export interface DivisionPageData {
  division: ParsedDivision;
  parent: { name: string; href: string | null };
  parentWikiPageId: string | null;
  leadName: string | null;
  leadHref: string | null;
  personnel: ParsedDivisionPersonnel[];
  divisionPrograms: ParsedFundingProgram[];
}

export function loadDivisionPageData(record: import("@/data/kb").KBRecordEntry): DivisionPageData {
  const division = parseDivision(record);
  const parent = resolveEntityLink(division.ownerEntityId);

  // Resolve lead if present (may be a person entity ID or a plain name)
  let leadName: string | null = null;
  let leadHref: string | null = null;
  if (division.lead) {
    const resolved = resolveEntityLink(division.lead);
    leadName = resolved.name;
    leadHref = resolved.href;
  }

  // Find funding programs linked to this division
  const allPrograms = getAllKBRecords("funding-programs");
  const divisionPrograms = allPrograms
    .filter((p) => {
      const divId = p.fields.divisionId;
      return typeof divId === "string" && divId === division.key;
    })
    .map(parseFundingProgram)
    .sort((a, b) => (b.totalBudget ?? 0) - (a.totalBudget ?? 0));

  // Find division personnel (stored under synthetic key __division__<divisionId>)
  const personnelRecords = getKBRecords(`__division__${division.key}`, "division-personnel");
  const personnel = personnelRecords
    .map(parseDivisionPersonnel)
    .sort((a, b) => a.personName.localeCompare(b.personName));

  // Parent wiki page link
  const parentTypedEntity = getTypedEntityById(division.ownerEntityId);
  const parentWikiPageId = parentTypedEntity?.numericId ?? null;

  return {
    division,
    parent,
    parentWikiPageId,
    leadName,
    leadHref,
    personnel,
    divisionPrograms,
  };
}
