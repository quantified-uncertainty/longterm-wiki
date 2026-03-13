import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  getAllKBRecords,
  getKBEntity,
  getKBEntitySlug,
  getKBRecords,
} from "@/data/kb";
import type { KBRecordEntry } from "@/data/kb";
import { getTypedEntityById } from "@/data/database";
import { formatCompactCurrency } from "@/lib/format-compact";
import { Breadcrumbs } from "@/components/directory";
import { safeHref } from "@/lib/directory-utils";
import {
  formatKBDate,
  titleCase,
  isUrl,
  shortDomain,
} from "@/components/wiki/kb/format";

// ── Types ──────────────────────────────────────────────────────────────

interface ParsedDivision {
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

interface ParsedFundingProgram {
  key: string;
  name: string;
  programType: string;
  description: string | null;
  totalBudget: number | null;
  status: string | null;
  deadline: string | null;
  openDate: string | null;
}

interface ParsedDivisionPersonnel {
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

function resolveEntityLink(entityId: string): { name: string; href: string | null } {
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

function parseDivision(record: KBRecordEntry): ParsedDivision {
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

function parseFundingProgram(record: KBRecordEntry): ParsedFundingProgram {
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

function parseDivisionPersonnel(record: KBRecordEntry): ParsedDivisionPersonnel {
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

function findDivisionBySlug(slug: string): KBRecordEntry | undefined {
  const allDivisions = getAllKBRecords("divisions");
  return allDivisions.find((d) => {
    const divSlug = d.fields.slug as string | undefined;
    return divSlug === slug || d.key === slug;
  });
}

function getAllDivisionSlugs(): string[] {
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

// ── Static params ──────────────────────────────────────────────────────

export function generateStaticParams() {
  return getAllDivisionSlugs().map((slug) => ({ slug }));
}

// ── Metadata ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ slug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug } = await params;
  const record = findDivisionBySlug(slug);
  if (!record) {
    return { title: "Division Not Found" };
  }
  const division = parseDivision(record);
  const parent = resolveEntityLink(division.ownerEntityId);

  return {
    title: `${division.name} | ${parent.name} | Divisions`,
    description: `${division.name} — ${titleCase(division.divisionType)} of ${parent.name}.`,
  };
}

// ── Status / type labels & colors ──────────────────────────────────────

const DIVISION_TYPE_LABELS: Record<string, string> = {
  fund: "Fund",
  team: "Team",
  department: "Department",
  lab: "Lab",
  "program-area": "Program Area",
};

const DIVISION_TYPE_COLORS: Record<string, string> = {
  fund: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  team: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  department: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
  lab: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
  "program-area": "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  inactive: "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
  dissolved: "bg-red-100 text-red-700 dark:bg-red-900/30 dark:text-red-300",
};

const PROGRAM_TYPE_LABELS: Record<string, string> = {
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

const PROGRAM_TYPE_COLORS: Record<string, string> = {
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

// ── Page ───────────────────────────────────────────────────────────────

export default async function DivisionDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const record = findDivisionBySlug(slug);

  if (!record) notFound();

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

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          ...(parent.href
            ? [{ label: parent.name, href: parent.href }]
            : []),
          { label: division.name },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-3 mb-3">
          <h1 className="text-2xl font-extrabold tracking-tight flex-1">
            {division.name}
          </h1>
          {division.status && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                STATUS_COLORS[division.status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {titleCase(division.status)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
              DIVISION_TYPE_COLORS[division.divisionType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
            }`}
          >
            {DIVISION_TYPE_LABELS[division.divisionType] ?? titleCase(division.divisionType)}
          </span>
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Left column: key details */}
        <div className="space-y-4">
          <DetailSection title="Parent Organization">
            <EntityLinkDisplay
              name={parent.name}
              href={parent.href}
            />
            {parentWikiPageId && (
              <Link
                href={`/wiki/${parentWikiPageId}`}
                className="ml-2 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                title="Wiki page"
              >
                wiki
              </Link>
            )}
          </DetailSection>

          {leadName && (
            <DetailSection title="Lead">
              {leadHref ? (
                <Link
                  href={leadHref}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {leadName}
                </Link>
              ) : (
                <span className="text-sm text-foreground">{leadName}</span>
              )}
            </DetailSection>
          )}

          {(division.startDate || division.endDate) && (
            <DetailSection title="Active Period">
              <span className="text-sm text-foreground">
                {division.startDate ?? "?"}
                {" — "}
                {division.endDate ?? "present"}
              </span>
            </DetailSection>
          )}
        </div>

        {/* Right column: supplementary info */}
        <div className="space-y-4">
          {division.website && (
            <DetailSection title="Website">
              <a
                href={safeHref(division.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline break-all"
              >
                {shortDomain(division.website)}
                <span className="text-muted-foreground ml-1">{"\u2197"}</span>
              </a>
            </DetailSection>
          )}

          {division.source && (
            <DetailSection title="Source">
              {isUrl(division.source) ? (
                <a
                  href={safeHref(division.source)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline break-all"
                >
                  {shortDomain(division.source)}
                  <span className="text-muted-foreground ml-1">{"\u2197"}</span>
                </a>
              ) : (
                <span className="text-sm text-foreground">{division.source}</span>
              )}
            </DetailSection>
          )}

          {division.notes && (
            <DetailSection title="Notes">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {division.notes}
              </p>
            </DetailSection>
          )}
        </div>
      </div>

      {/* Team Members */}
      {personnel.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-base font-bold tracking-tight">Team Members</h2>
            <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {personnel.length}
            </span>
            <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
          </div>
          <div className="border border-border/60 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="text-left py-2 px-3 font-medium">Name</th>
                  <th className="text-left py-2 px-3 font-medium">Role</th>
                  <th className="text-center py-2 px-3 font-medium">Dates</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {personnel.map((p) => (
                  <tr key={p.key} className="hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-3">
                      {p.personHref ? (
                        <Link
                          href={p.personHref}
                          className="font-medium text-primary text-xs hover:underline"
                        >
                          {p.personName}
                        </Link>
                      ) : (
                        <span className="font-medium text-foreground text-xs">
                          {p.personName}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-xs text-muted-foreground">
                      {p.role}
                    </td>
                    <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                      {p.startDate && (
                        <span>
                          {p.startDate}
                          {p.endDate ? ` - ${p.endDate}` : " - present"}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Funding Programs */}
      {divisionPrograms.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-base font-bold tracking-tight">Funding Programs</h2>
            <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {divisionPrograms.length}
            </span>
            <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
          </div>
          <div className="border border-border/60 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="text-left py-2 px-3 font-medium">Program</th>
                  <th className="text-left py-2 px-3 font-medium">Type</th>
                  <th className="text-right py-2 px-3 font-medium">Budget</th>
                  <th className="text-center py-2 px-3 font-medium">Status</th>
                  <th className="text-center py-2 px-3 font-medium">Deadline</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {divisionPrograms.map((p) => (
                  <tr key={p.key} className="hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-3">
                      <Link
                        href={`/funding-programs/${p.key}`}
                        className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                      >
                        {p.name}
                      </Link>
                      {p.description && (
                        <div className="text-[10px] text-muted-foreground/60 mt-0.5 line-clamp-2">
                          {p.description}
                        </div>
                      )}
                    </td>
                    <td className="py-2 px-3">
                      <span
                        className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
                          PROGRAM_TYPE_COLORS[p.programType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                        }`}
                      >
                        {PROGRAM_TYPE_LABELS[p.programType] ?? p.programType}
                      </span>
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                      {p.totalBudget != null && (
                        <span className="font-semibold">{formatCompactCurrency(p.totalBudget)}</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-center text-xs">
                      {p.status && (
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            p.status === "open"
                              ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300"
                              : p.status === "awarded"
                                ? "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300"
                                : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                          }`}
                        >
                          {titleCase(p.status)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                      {p.deadline ?? p.openDate ?? ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      )}

      {/* Back to parent org */}
      <div className="mt-8 pt-6 border-t border-border/60">
        {parent.href ? (
          <Link
            href={parent.href}
            className="text-sm text-primary hover:underline"
          >
            &larr; Back to {parent.name}
          </Link>
        ) : (
          <Link
            href="/organizations"
            className="text-sm text-primary hover:underline"
          >
            &larr; Back to organizations
          </Link>
        )}
      </div>
    </div>
  );
}

// ── Subcomponents ──────────────────────────────────────────────────────

function DetailSection({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div>
      <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
        {title}
      </div>
      <div className="flex items-center gap-1 flex-wrap">{children}</div>
    </div>
  );
}

function EntityLinkDisplay({
  name,
  href,
}: {
  name: string;
  href: string | null;
}) {
  if (href) {
    return (
      <Link
        href={href}
        className="text-sm font-medium text-primary hover:underline"
      >
        {name}
      </Link>
    );
  }
  return <span className="text-sm font-medium text-foreground">{name}</span>;
}
