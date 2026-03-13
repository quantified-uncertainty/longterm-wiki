import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import {
  getAllKBRecordsByCollection,
  getKBEntity,
  getKBEntitySlug,
} from "@/data/kb";
import type { KBRecordEntry } from "@/data/kb";
import { getTypedEntityById } from "@/data/database";
import { formatCompactCurrency } from "@/lib/format-compact";
import { Breadcrumbs } from "@/components/directory";
import {
  formatKBDate,
  titleCase,
  isUrl,
  shortDomain,
} from "@/components/wiki/kb/format";

// ── Types ──────────────────────────────────────────────────────────────

interface ParsedFundingProgram {
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

interface ParsedGrant {
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

function parseFundingProgram(record: KBRecordEntry): ParsedFundingProgram {
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

function parseGrant(record: KBRecordEntry): ParsedGrant {
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

// ── Static params ──────────────────────────────────────────────────────

export function generateStaticParams() {
  const allPrograms = getAllKBRecordsByCollection("funding-programs");
  return allPrograms.map((record) => ({ id: record.key }));
}

// ── Metadata ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const allPrograms = getAllKBRecordsByCollection("funding-programs");
  const record = allPrograms.find((r) => r.key === id);
  if (!record) {
    return { title: "Funding Program Not Found" };
  }
  const program = parseFundingProgram(record);
  const funder = resolveEntityLink(program.ownerEntityId);
  const parts = [program.name];
  if (funder.name) parts.push(`by ${funder.name}`);
  if (program.totalBudget) parts.push(formatCompactCurrency(program.totalBudget));

  return {
    title: `${program.name} | Funding Programs`,
    description: parts.join(" — "),
  };
}

// ── Status badge colors ────────────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  open: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/30 dark:text-emerald-300",
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  awarded: "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
  completed: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  closed: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
  "winding-down": "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
  terminated: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
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

export default async function FundingProgramDetailPage({ params }: PageProps) {
  const { id } = await params;
  const allPrograms = getAllKBRecordsByCollection("funding-programs");
  const record = allPrograms.find((r) => r.key === id);

  if (!record) notFound();

  const program = parseFundingProgram(record);
  const funder = resolveEntityLink(program.ownerEntityId);

  // Resolve division if present
  let divisionName: string | null = null;
  let divisionHref: string | null = null;
  if (program.divisionId) {
    // Look up division in KB records
    const allDivisions = getAllKBRecordsByCollection("divisions");
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
  const allGrants = getAllKBRecordsByCollection("grants");
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

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          ...(funder.href
            ? [{ label: funder.name, href: funder.href }]
            : []),
          { label: program.name },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-3 mb-3">
          <h1 className="text-2xl font-extrabold tracking-tight flex-1">
            {program.name}
          </h1>
          {program.status && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                STATUS_COLORS[program.status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {titleCase(program.status)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
              PROGRAM_TYPE_COLORS[program.programType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
            }`}
          >
            {PROGRAM_TYPE_LABELS[program.programType] ?? titleCase(program.programType)}
          </span>
        </div>

        {/* Budget hero */}
        {program.totalBudget != null && (
          <div className="text-3xl font-bold tabular-nums tracking-tight text-primary mt-3 mb-1">
            {formatCompactCurrency(program.totalBudget)}
            {program.currency && program.currency !== "USD" && (
              <span className="text-base font-medium text-muted-foreground ml-2">
                {program.currency}
              </span>
            )}
            <span className="text-sm font-normal text-muted-foreground ml-2">budget</span>
          </div>
        )}
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Left column: key details */}
        <div className="space-y-4">
          <DetailSection title="Funder Organization">
            <EntityLinkDisplay
              name={funder.name}
              href={funder.href}
            />
            {funderWikiPageId && (
              <Link
                href={`/wiki/${funderWikiPageId}`}
                className="ml-2 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                title="Wiki page"
              >
                wiki
              </Link>
            )}
          </DetailSection>

          {divisionName && (
            <DetailSection title="Division">
              {divisionHref ? (
                <Link
                  href={divisionHref}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {divisionName}
                </Link>
              ) : (
                <span className="text-sm text-foreground">{divisionName}</span>
              )}
            </DetailSection>
          )}

          {(program.openDate || program.deadline) && (
            <DetailSection title="Timeline">
              <span className="text-sm text-foreground">
                {program.openDate && (
                  <>
                    <span className="text-muted-foreground text-xs">Opens:</span>{" "}
                    {formatKBDate(program.openDate)}
                  </>
                )}
                {program.openDate && program.deadline && " — "}
                {program.deadline && (
                  <>
                    <span className="text-muted-foreground text-xs">Deadline:</span>{" "}
                    {formatKBDate(program.deadline)}
                  </>
                )}
              </span>
            </DetailSection>
          )}
        </div>

        {/* Right column: supplementary info */}
        <div className="space-y-4">
          {program.applicationUrl && (
            <DetailSection title="Application">
              <a
                href={program.applicationUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline break-all"
              >
                {shortDomain(program.applicationUrl)}
                <span className="text-muted-foreground ml-1">{"\u2197"}</span>
              </a>
            </DetailSection>
          )}

          {program.source && (
            <DetailSection title="Source">
              {isUrl(program.source) ? (
                <a
                  href={program.source}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline break-all"
                >
                  {shortDomain(program.source)}
                  <span className="text-muted-foreground ml-1">{"\u2197"}</span>
                </a>
              ) : (
                <span className="text-sm text-foreground">{program.source}</span>
              )}
            </DetailSection>
          )}

          {program.description && (
            <DetailSection title="Description">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {program.description}
              </p>
            </DetailSection>
          )}

          {program.notes && (
            <DetailSection title="Notes">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {program.notes}
              </p>
            </DetailSection>
          )}
        </div>
      </div>

      {/* Grants awarded through this program */}
      {programGrants.length > 0 && (
        <section className="mb-8">
          <div className="flex items-center gap-3 mb-4">
            <h2 className="text-base font-bold tracking-tight">Grants Awarded</h2>
            <span className="text-[11px] font-medium tabular-nums px-2 py-0.5 rounded-full bg-muted text-muted-foreground">
              {programGrants.length}
            </span>
            {totalGranted > 0 && (
              <span className="text-xs text-muted-foreground">
                Total: {formatCompactCurrency(totalGranted)}
              </span>
            )}
            <div className="flex-1 h-px bg-gradient-to-r from-border/60 to-transparent" />
          </div>
          <div className="border border-border/60 rounded-xl overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
                  <th className="text-left py-2 px-3 font-medium">Grant</th>
                  <th className="text-left py-2 px-3 font-medium">Recipient</th>
                  <th className="text-right py-2 px-3 font-medium">Amount</th>
                  <th className="text-center py-2 px-3 font-medium">Date</th>
                  <th className="text-center py-2 px-3 font-medium">Status</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-border/50">
                {programGrants.map((g) => (
                  <tr key={g.key} className="hover:bg-muted/20 transition-colors">
                    <td className="py-2 px-3">
                      <Link
                        href={`/grants/${g.key}`}
                        className="font-medium text-foreground text-xs hover:text-primary transition-colors"
                      >
                        {g.name}
                      </Link>
                    </td>
                    <td className="py-2 px-3 text-xs">
                      {g.recipientHref ? (
                        <Link href={g.recipientHref} className="text-primary hover:underline">
                          {g.recipientName}
                        </Link>
                      ) : (
                        <span className="text-muted-foreground">{g.recipientName}</span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-right tabular-nums whitespace-nowrap text-xs">
                      {g.amount != null && (
                        <span className="font-semibold">
                          {formatCompactCurrency(g.amount)}
                        </span>
                      )}
                    </td>
                    <td className="py-2 px-3 text-center text-muted-foreground text-xs">
                      {g.date ? formatKBDate(g.date) : g.period ?? ""}
                    </td>
                    <td className="py-2 px-3 text-center text-xs">
                      {g.status && (
                        <span
                          className={`inline-block px-2 py-0.5 rounded-full text-[10px] font-medium ${
                            g.status === "active"
                              ? "bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-300"
                              : g.status === "completed"
                                ? "bg-slate-100 text-slate-600 dark:bg-slate-800 dark:text-slate-300"
                                : "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
                          }`}
                        >
                          {titleCase(g.status)}
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

      {/* Back to funder */}
      <div className="mt-8 pt-6 border-t border-border/60">
        {funder.href ? (
          <Link
            href={funder.href}
            className="text-sm text-primary hover:underline"
          >
            &larr; Back to {funder.name}
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
