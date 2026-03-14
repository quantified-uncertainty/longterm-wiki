import { notFound } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";
import { Breadcrumbs } from "@/components/directory";
import { safeHref } from "@/lib/directory-utils";
import {
  titleCase,
  shortDomain,
} from "@/components/wiki/kb/format";

import {
  findDivision,
  getAllDivisionParams,
  loadDivisionPageData,
  resolveEntityLink,
  parseDivision,
  DIVISION_TYPE_LABELS,
  DIVISION_TYPE_COLORS,
  STATUS_COLORS,
} from "@/app/divisions/[slug]/division-data";
import {
  TeamMembersSection,
  FundingProgramsSection,
  DivisionGrantsSection,
  BackToParentLink,
} from "@/app/divisions/[slug]/division-sections";
import { ProfileTabs, type ProfileTab } from "@/components/directory/ProfileTabs";

// ── Tabs builder ──────────────────────────────────────────────────────

function DivisionTabs({ data }: { data: import("@/app/divisions/[slug]/division-data").DivisionPageData }) {
  const tabs: ProfileTab[] = [];

  if (data.personnel.length > 0) {
    tabs.push({
      id: "people",
      label: "People",
      count: data.personnel.length,
      content: <TeamMembersSection personnel={data.personnel} />,
    });
  }

  if (data.grants.length > 0) {
    tabs.push({
      id: "grants",
      label: "Grants",
      count: data.grants.length,
      content: <DivisionGrantsSection grants={data.grants} />,
    });
  }

  if (data.divisionPrograms.length > 0) {
    tabs.push({
      id: "programs",
      label: "Programs",
      count: data.divisionPrograms.length,
      content: <FundingProgramsSection programs={data.divisionPrograms} />,
    });
  }

  if (tabs.length === 0) return null;

  return <ProfileTabs tabs={tabs} />;
}

// ── Static params ──────────────────────────────────────────────────────

export function generateStaticParams() {
  return getAllDivisionParams();
}

// ── Metadata ───────────────────────────────────────────────────────────

interface PageProps {
  params: Promise<{ slug: string; divSlug: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { slug, divSlug } = await params;
  const record = findDivision(slug, divSlug);
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
  const { slug, divSlug } = await params;
  const record = findDivision(slug, divSlug);

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

      {/* Compact header — mirrors org page pattern */}
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1 flex-wrap">
          <h1 className="text-2xl font-extrabold tracking-tight">
            {data.division.name}
          </h1>
          <span
            className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
              DIVISION_TYPE_COLORS[data.division.divisionType] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
            }`}
          >
            {DIVISION_TYPE_LABELS[data.division.divisionType] ?? titleCase(data.division.divisionType)}
          </span>
          {data.division.status && (
            <span
              className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold ${
                STATUS_COLORS[data.division.status] ?? "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400"
              }`}
            >
              {titleCase(data.division.status)}
            </span>
          )}
        </div>

        {/* Inline metadata row */}
        <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
          {data.parent.href ? (
            <Link href={data.parent.href} className="text-primary hover:text-primary/80 font-medium transition-colors">
              {data.parent.name}
            </Link>
          ) : (
            <span>{data.parent.name}</span>
          )}
          {data.leadName && (
            <>
              <span className="text-muted-foreground/30">&middot;</span>
              <span>
                Lead:{" "}
                {data.leadHref ? (
                  <Link href={data.leadHref} className="text-primary hover:underline">
                    {data.leadName}
                  </Link>
                ) : (
                  data.leadName
                )}
              </span>
            </>
          )}
          {(data.division.startDate || data.division.endDate) && (
            <>
              <span className="text-muted-foreground/30">&middot;</span>
              <span>
                {data.division.startDate ?? "?"}
                {" \u2013 "}
                {data.division.endDate ?? "present"}
              </span>
            </>
          )}
          {data.division.website && (
            <>
              <span className="text-muted-foreground/30">&middot;</span>
              <a
                href={safeHref(data.division.website)}
                target="_blank"
                rel="noopener noreferrer"
                className="text-primary hover:text-primary/80 font-medium transition-colors"
              >
                {shortDomain(data.division.website)} &#8599;
              </a>
            </>
          )}
          {data.parentWikiPageId && (
            <>
              <span className="text-muted-foreground/30">&middot;</span>
              <Link href={`/wiki/${data.parentWikiPageId}`} className="text-primary hover:text-primary/80 font-medium transition-colors">
                Wiki page &rarr;
              </Link>
            </>
          )}
        </div>

        {data.division.notes && (
          <p className="text-sm text-muted-foreground leading-relaxed mt-2 max-w-prose">
            {data.division.notes}
          </p>
        )}
      </div>

      {/* Tabbed content */}
      <DivisionTabs data={data} />

      {/* Back to parent org */}
      <BackToParentLink parent={data.parent} />
    </div>
  );
}
