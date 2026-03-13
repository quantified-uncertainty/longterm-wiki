import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { getAllKBRecords } from "@/data/kb";
import { formatCompactCurrency } from "@/lib/format-compact";
import { Breadcrumbs } from "@/components/directory";
import { safeHref } from "@/lib/directory-utils";
import {
  formatKBDate,
  titleCase,
  isUrl,
  shortDomain,
} from "@/components/wiki/kb/format";

import {
  parseFundingProgram,
  resolveEntityLink,
  loadProgramPageData,
  STATUS_COLORS,
  PROGRAM_TYPE_LABELS,
  PROGRAM_TYPE_COLORS,
} from "./program-data";
import { DetailSection, EntityLinkDisplay } from "./program-shared";
import { GrantsAwardedSection, BackToFunderLink } from "./program-sections";

// ── Static params ──────────────────────────────────────────────────────

export function generateStaticParams() {
  const allPrograms = getAllKBRecords("funding-programs");
  return allPrograms.map((record) => ({ id: record.key }));
}

// ── Metadata ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { id } = await params;
  const allPrograms = getAllKBRecords("funding-programs");
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

// ── Page ───────────────────────────────────────────────────────────────

export default async function FundingProgramDetailPage({ params }: PageProps) {
  const { id } = await params;
  const allPrograms = getAllKBRecords("funding-programs");
  const record = allPrograms.find((r) => r.key === id);

  if (!record) return notFound();

  const data = loadProgramPageData(record);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          ...(data.funder.href
            ? [{ label: data.funder.name, href: data.funder.href }]
            : []),
          { label: data.program.name },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-3 mb-3">
          <h1 className="text-2xl font-extrabold tracking-tight flex-1">
            {data.program.name}
          </h1>
          {data.program.status && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                STATUS_COLORS[data.program.status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {titleCase(data.program.status)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
              PROGRAM_TYPE_COLORS[data.program.programType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
            }`}
          >
            {PROGRAM_TYPE_LABELS[data.program.programType] ?? titleCase(data.program.programType)}
          </span>
        </div>

        {/* Budget hero */}
        {data.program.totalBudget != null && (
          <div className="text-3xl font-bold tabular-nums tracking-tight text-primary mt-3 mb-1">
            {formatCompactCurrency(data.program.totalBudget)}
            {data.program.currency && data.program.currency !== "USD" && (
              <span className="text-base font-medium text-muted-foreground ml-2">
                {data.program.currency}
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

        {/* Right column: supplementary info */}
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
                <span className="text-muted-foreground ml-1">{"\u2197"}</span>
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
                  <span className="text-muted-foreground ml-1">{"\u2197"}</span>
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
              <p className="text-sm text-muted-foreground leading-relaxed">
                {data.program.notes}
              </p>
            </DetailSection>
          )}
        </div>
      </div>

      {/* Grants awarded through this program */}
      <GrantsAwardedSection
        grants={data.programGrants}
        totalGranted={data.totalGranted}
      />

      {/* Back to funder */}
      <BackToFunderLink funder={data.funder} />
    </div>
  );
}
