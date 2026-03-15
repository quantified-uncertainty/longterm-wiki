/**
 * Data-fetching, parsing, and type definitions for funding program detail pages.
 * Extracted from page.tsx as a pure refactor — no behavioral changes.
 */
import {
  getAllKBRecords,
  getKBEntity,
  getKBEntitySlug,
} from "@/data/factbase";
import type { KBRecordEntry } from "@/data/factbase";
import { getTypedEntityById } from "@/data/tablebase";
import {
  titleCase,
} from "@/components/wiki/factbase/format";

// ── Types ──────────────────────────────────────────────────────────────

export interface ParsedFundingProgram {
  key: string;
  ownerEntityId: string;
  name: string;
  programType: string;
  description: string | null;
  divisionId: string | null;
  totalBudget: number | null;
  currency: string;
  applicationUrl: string | null;
  openDate: string | null;
  deadline: string | null;
  status: string | null;
  source: string | null;
  notes: string | null;
}

export interface ParsedGrant {
  key: string;
  ownerEntityId: string;
  name: string;
  recipientId: string | null;
  recipientName: string;
  recipientHref: string | null;
  amount: number | null;
  date: string | null;
  period: string | null;
  status: string | null;
  source: string | null;
  programId: string | null;
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
    return { name: entity.name, href: `/factbase/entity/${entityId}` };
  }
  return { name: titleCase(entityId.replace(/-/g, " ")), href: null };
}

// ── Record parsers ────────────────────────────────────────────────────

export function parseFundingProgram(record: KBRecordEntry): ParsedFundingProgram {
  const f = record.fields;
  return {
    key: record.key,
    ownerEntityId: record.ownerEntityId,
    name: (f.name as string) ?? record.key,
    programType: (f.programType as string) ?? "grant-round",
    description: (f.description as string) ?? null,
    divisionId: (f.divisionId as string) ?? null,
    totalBudget: typeof f.totalBudget === "number" ? f.totalBudget : null,
    currency: (f.currency as string) ?? "USD",
    applicationUrl: (f.applicationUrl as string) ?? null,
    openDate: (f.openDate as string) ?? null,
    deadline: (f.deadline as string) ?? null,
    status: (f.status as string) ?? null,
    source: (f.source as string) ?? null,
    notes: (f.notes as string) ?? null,
  };
}

export function parseGrant(record: KBRecordEntry): ParsedGrant {
  const f = record.fields;
  const recipientId = typeof f.recipient === "string" ? f.recipient : null;
  const recipient = recipientId
    ? resolveEntityLink(recipientId)
    : { name: "", href: null };

  return {
    key: record.key,
    ownerEntityId: record.ownerEntityId,
    name: (f.name as string) ?? record.key,
    recipientId,
    recipientName: recipient.name,
    recipientHref: recipient.href,
    amount: typeof f.amount === "number" ? f.amount : null,
    date: typeof f.date === "string" ? f.date : null,
    period: typeof f.period === "string" ? f.period : null,
    status: typeof f.status === "string" ? f.status : null,
    source: typeof f.source === "string" ? f.source : null,
    programId: typeof f.programId === "string" ? f.programId : null,
  };
}

// ── Status badge colors ────────────────────────────────────────────────

export const STATUS_COLORS: Record<string, string> = {
  open: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  awarded: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  completed: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  closed: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  "winding-down": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  terminated: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
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

export interface ProgramPageData {
  program: ParsedFundingProgram;
  funder: { name: string; href: string | null };
  funderWikiPageId: string | null;
  divisionName: string | null;
  divisionHref: string | null;
  programGrants: ParsedGrant[];
  totalGranted: number;
}

export function loadProgramPageData(record: import("@/data/factbase").KBRecordEntry): ProgramPageData {
  const program = parseFundingProgram(record);
  const funder = resolveEntityLink(program.ownerEntityId);

  // Resolve division if present
  let divisionName: string | null = null;
  let divisionHref: string | null = null;
  if (program.divisionId) {
    // Look up division in KB records
    const allDivisions = getAllKBRecords("divisions");
    const divRecord = allDivisions.find((d) => d.key === program.divisionId);
    if (divRecord) {
      divisionName = (divRecord.fields.name as string) ?? program.divisionId;
      const divSlug = (divRecord.fields.slug as string) ?? null;
      if (divSlug) {
        divisionHref = `/divisions/${divSlug}`;
      }
    }
  }

  // Find grants linked to this program (by programId)
  const allGrants = getAllKBRecords("grants");
  const programGrants = allGrants
    .filter((g) => {
      const grantProgramId = g.fields.programId;
      if (typeof grantProgramId === "string" && grantProgramId === program.key) return true;
      // Also match by program field (YAML grants use program name as string)
      const grantProgram = g.fields.program;
      if (typeof grantProgram === "string" && grantProgram === program.key) return true;
      return false;
    })
    .map(parseGrant)
    .sort((a, b) => (b.amount ?? 0) - (a.amount ?? 0));

  const totalGranted = programGrants.reduce((sum, g) => sum + (g.amount ?? 0), 0);

  // Funder wiki page link
  const funderTypedEntity = getTypedEntityById(program.ownerEntityId);
  const funderWikiPageId = funderTypedEntity?.numericId ?? null;

  return {
    program,
    funder,
    funderWikiPageId,
    divisionName,
    divisionHref,
    programGrants,
    totalGranted,
  };
}
