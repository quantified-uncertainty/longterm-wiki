import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getAllKBRecords, type KBRecordEntry } from "@/data/factbase";
import { getRecordVerdict } from "@/data/tablebase";
import { formatCompactCurrency } from "@/lib/format-compact";
import { ProfileStatCard } from "@/components/directory";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";
import { safeHref } from "@/lib/directory-utils";
import {
  formatKBDate,
  titleCase,
  isUrl,
  shortDomain,
} from "@/components/wiki/factbase/format";

import {
  parseFundingProgram,
  resolveEntityLink,
  loadProgramPageData,
  STATUS_COLORS,
  PROGRAM_TYPE_LABELS,
  PROGRAM_TYPE_COLORS,
} from "./program-data";
import { DetailSection, EntityLinkDisplay } from "./program-shared";
import { GrantsAwardedSection } from "./program-sections";

// ── Static params ──────────────────────────────────────────────────────

export function generateStaticParams() {
  const allPrograms = getAllKBRecords("funding-programs");
  return allPrograms.map((record) => ({ id: record.slug ?? record.key }));
}

// ── Lookup helpers ─────────────────────────────────────────────────────

/** Find a record by slug (preferred) or fall back to legacy 10-char key. */
function findProgramRecord(idOrSlug: string): KBRecordEntry | undefined {
  const allPrograms = getAllKBRecords("funding-programs");
  return (
    allPrograms.find((r) => r.slug === idOrSlug) ??
    allPrograms.find((r) => r.key === idOrSlug)
  );
}

// ── Metadata ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const record = findProgramRecord(id);
  if (!record) {
    return { title: "Funding Program Not Found" };
  }
  const program = parseFundingProgram(record);
  const funder = resolveEntityLink(program.ownerEntityId);
  const parts = [program.name];
  if (funder.name) parts.push(`by ${funder.name}`);
  if (program.totalBudget != null) parts.push(formatCompactCurrency(program.totalBudget, program.currency));

  return {
    title: `${program.name} | Funding Programs`,
    description: parts.join(" — "),
  };
}

// ── Page ───────────────────────────────────────────────────────────────

export default async function FundingProgramDetailPage({ params }: PageProps) {
  const { id } = await params;
  const record = findProgramRecord(id);

  if (!record) return notFound();

  // Legacy URL: `/funding-programs/<10-char-key>` redirects to slug URL.
  // findProgramRecord prefers slug match, so reaching `record.key === id`
  // means slug match missed → request was by legacy key.
  if (record.slug && record.key === id) {
    redirect(`/funding-programs/${record.slug}`);
  }

  const data = loadProgramPageData(record);
  const programVerdict = getRecordVerdict("funding-program", String(data.program.key));

  const titlePills = (
    <>
      {data.program.status && (
        <span
          className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold ${
            STATUS_COLORS[data.program.status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
          }`}
        >
          {titleCase(data.program.status)}
        </span>
      )}
      <span
        className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
          PROGRAM_TYPE_COLORS[data.program.programType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
        }`}
      >
        {PROGRAM_TYPE_LABELS[data.program.programType] ?? titleCase(data.program.programType)}
      </span>
    </>
  );

  const stats: Array<{ label: string; value: string }> = [];
  if (data.program.totalBudget != null) {
    stats.push({
      label: "Budget",
      value: formatCompactCurrency(data.program.totalBudget, data.program.currency),
    });
  }
  if (data.program.openDate) {
    stats.push({ label: "Opens", value: formatKBDate(data.program.openDate) });
  }
  if (data.program.deadline) {
    stats.push({ label: "Deadline", value: formatKBDate(data.program.deadline) });
  }

  const statCards = stats.length > 0 && (
    <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
      {stats.map((s) => (
        <ProfileStatCard key={s.label} {...s} />
      ))}
    </div>
  );

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: "Organizations", href: "/organizations" },
        ...(data.funder.href
          ? [{ label: data.funder.name, href: data.funder.href }]
          : []),
        { label: data.program.name },
      ]}
      title={data.program.name}
      titlePills={titlePills}
      verdict={programVerdict?.verdict ?? null}
      verdictHref={
        programVerdict?.verdict
          ? getSourcingHref("funding-program", String(data.program.key))
          : undefined
      }
      statCards={statCards}
    >
      <div className="space-y-8">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="space-y-4">
            <DetailSection title="Funder Organization">
              <EntityLinkDisplay
                name={data.funder.name}
                href={data.funder.href}
              />
              {data.funderWikiPageId && (
                <Link
                  href={`/wiki/${data.funderWikiPageId}`}
                  className="ml-2 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                  title="Wiki page"
                >
                  wiki
                </Link>
              )}
            </DetailSection>

            {data.divisionName && (
              <DetailSection title="Division">
                {data.divisionHref ? (
                  <Link
                    href={data.divisionHref}
                    className="text-sm font-medium text-primary hover:underline"
                  >
                    {data.divisionName}
                  </Link>
                ) : (
                  <span className="text-sm text-foreground">{data.divisionName}</span>
                )}
              </DetailSection>
            )}

            {(data.program.openDate || data.program.deadline) && (
              <DetailSection title="Timeline">
                <span className="text-sm text-foreground">
                  {data.program.openDate && (
                    <>
                      <span className="text-muted-foreground text-xs">Opens:</span>{" "}
                      {formatKBDate(data.program.openDate)}
                    </>
                  )}
                  {data.program.openDate && data.program.deadline && " — "}
                  {data.program.deadline && (
                    <>
                      <span className="text-muted-foreground text-xs">Deadline:</span>{" "}
                      {formatKBDate(data.program.deadline)}
                    </>
                  )}
                </span>
              </DetailSection>
            )}
          </div>

          <div className="space-y-4">
            {data.program.applicationUrl && (
              <DetailSection title="Application">
                <a
                  href={safeHref(data.program.applicationUrl)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline break-all"
                >
                  {shortDomain(data.program.applicationUrl)}
                  <span className="text-muted-foreground ml-1">{"↗"}</span>
                </a>
              </DetailSection>
            )}

            {data.program.source && (
              <DetailSection title="Source">
                {isUrl(data.program.source) ? (
                  <a
                    href={safeHref(data.program.source)}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-sm text-primary hover:underline break-all"
                  >
                    {shortDomain(data.program.source)}
                    <span className="text-muted-foreground ml-1">{"↗"}</span>
                  </a>
                ) : (
                  <span className="text-sm text-foreground">{data.program.source}</span>
                )}
              </DetailSection>
            )}

            {data.program.description && (
              <DetailSection title="Description">
                <p className="text-sm text-muted-foreground leading-relaxed">
                  {data.program.description}
                </p>
              </DetailSection>
            )}

            {data.program.notes && (
              <DetailSection title="Notes">
                <p className="text-sm text-muted-foreground leading-relaxed whitespace-pre-wrap">
                  {data.program.notes.replace(/\\n/g, "\n")}
                </p>
              </DetailSection>
            )}
          </div>
        </div>

        <GrantsAwardedSection
          grants={data.programGrants}
          totalGranted={data.totalGranted}
        />
      </div>
    </EntityProfileShell>
  );
}
