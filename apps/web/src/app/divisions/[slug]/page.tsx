import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/directory";
import { safeHref } from "@/lib/directory-utils";
import {
  titleCase,
  isUrl,
  shortDomain,
} from "@/components/wiki/kb/format";

import {
  findDivisionBySlug,
  getAllDivisionSlugs,
  loadDivisionPageData,
  resolveEntityLink,
  parseDivision,
  DIVISION_TYPE_LABELS,
  DIVISION_TYPE_COLORS,
  STATUS_COLORS,
} from "./division-data";
import { DetailSection, EntityLinkDisplay } from "./division-shared";
import {
  TeamMembersSection,
  FundingProgramsSection,
  BackToParentLink,
} from "./division-sections";

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

// ── Page ───────────────────────────────────────────────────────────────

export default async function DivisionDetailPage({ params }: PageProps) {
  const { slug } = await params;
  const record = findDivisionBySlug(slug);

  if (!record) return notFound();

  const data = loadDivisionPageData(record);

  return (
    <div className="max-w-4xl mx-auto px-6 py-8">
      {/* Breadcrumbs */}
      <Breadcrumbs
        items={[
          { label: "Organizations", href: "/organizations" },
          ...(data.parent.href
            ? [{ label: data.parent.name, href: data.parent.href }]
            : []),
          { label: data.division.name },
        ]}
      />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-3 mb-3">
          <h1 className="text-2xl font-extrabold tracking-tight flex-1">
            {data.division.name}
          </h1>
          {data.division.status && (
            <span
              className={`inline-flex items-center px-2.5 py-1 rounded-full text-xs font-semibold shrink-0 ${
                STATUS_COLORS[data.division.status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {titleCase(data.division.status)}
            </span>
          )}
        </div>

        <div className="flex items-center gap-3 flex-wrap">
          <span
            className={`inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold uppercase tracking-wider ${
              DIVISION_TYPE_COLORS[data.division.divisionType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
            }`}
          >
            {DIVISION_TYPE_LABELS[data.division.divisionType] ?? titleCase(data.division.divisionType)}
          </span>
        </div>
      </div>

      {/* Details grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-8">
        {/* Left column: key details */}
        <div className="space-y-4">
          <DetailSection title="Parent Organization">
            <EntityLinkDisplay
              name={data.parent.name}
              href={data.parent.href}
            />
            {data.parentWikiPageId && (
              <Link
                href={`/wiki/${data.parentWikiPageId}`}
                className="ml-2 text-[10px] text-muted-foreground/50 hover:text-primary transition-colors"
                title="Wiki page"
              >
                wiki
              </Link>
            )}
          </DetailSection>

          {data.leadName && (
            <DetailSection title="Lead">
              {data.leadHref ? (
                <Link
                  href={data.leadHref}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {data.leadName}
                </Link>
              ) : (
                <span className="text-sm text-foreground">{data.leadName}</span>
              )}
            </DetailSection>
          )}

          {(data.division.startDate || data.division.endDate) && (
            <DetailSection title="Active Period">
              <span className="text-sm text-foreground">
                {data.division.startDate ?? "?"}
                {" — "}
                {data.division.endDate ?? "present"}
              </span>
            </DetailSection>
          )}
        </div>

        {/* Right column: supplementary info */}
        <div className="space-y-4">
          {data.division.website && (
            <DetailSection title="Website">
              <a
                href={safeHref(data.division.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-sm text-primary hover:underline break-all"
              >
                {shortDomain(data.division.website)}
                <span className="text-muted-foreground ml-1">{"\u2197"}</span>
              </a>
            </DetailSection>
          )}

          {data.division.source && (
            <DetailSection title="Source">
              {isUrl(data.division.source) ? (
                <a
                  href={safeHref(data.division.source)}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline break-all"
                >
                  {shortDomain(data.division.source)}
                  <span className="text-muted-foreground ml-1">{"\u2197"}</span>
                </a>
              ) : (
                <span className="text-sm text-foreground">{data.division.source}</span>
              )}
            </DetailSection>
          )}

          {data.division.notes && (
            <DetailSection title="Notes">
              <p className="text-sm text-muted-foreground leading-relaxed">
                {data.division.notes}
              </p>
            </DetailSection>
          )}
        </div>
      </div>

      {/* Team Members */}
      <TeamMembersSection personnel={data.personnel} />

      {/* Funding Programs */}
      <FundingProgramsSection programs={data.divisionPrograms} />

      {/* Back to parent org */}
      <BackToParentLink parent={data.parent} />
    </div>
  );
}
