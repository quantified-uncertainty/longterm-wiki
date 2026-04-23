import Link from "next/link";
import {
  computeOrgCoverage,
  getOrgSignals,
  type OrgCoverageInput,
} from "@/components/coverage/coverage-score";
import {
  formatKBDate,
  shortDomain,
} from "@/components/wiki/factbase/format";
import type { EntityProfileShellHeaderLink } from "@/components/entity/EntityProfileShell";
import { safeHref } from "./org-shared";
import {
  ORG_TYPE_LABELS,
  ORG_TYPE_COLORS,
  DEFAULT_ORG_TYPE_COLOR,
  ORG_STATUS_LABELS,
  ORG_STATUS_COLORS,
  type AuthorRef,
} from "./org-data";

/**
 * Shell-slot builder for organization profile pages.
 *
 * Turns an `OrgHeaderData` record into the prop bag that `EntityProfileShell`
 * accepts. Used by both `/organizations/[slug]` and `/organizations/[slug]/data`.
 */

export interface OrgHeaderData {
  id: string;
  name: string;
  aliases?: string[];
  orgType: string | null;
  orgStatus: string | null;
  foundedDateStr: string | null;
  orgAge: string | null;
  hqText: string | null;
  websiteUrl: string | null;
  wikiHref: string | null;
  founders: AuthorRef[];
  /** Pre-computed coverage scoring input. */
  coverageInput?: OrgCoverageInput;
  /** Aggregate sourcing verdict for the entity. */
  verdict?: string | null;
}

export interface OrgShellSlots {
  entityId: string;
  avatar: React.ReactNode;
  title: string;
  aliases: string[] | undefined;
  titlePills: React.ReactNode;
  coverage?: { score: number; signals: string[] };
  verdict: string | null;
  metadata: React.ReactNode;
  headerLinks: EntityProfileShellHeaderLink[];
  headerFooter: React.ReactNode;
  breadcrumbs: Array<{ label: string; href?: string }>;
}

export function buildOrgShellSlots(
  data: OrgHeaderData,
  options: {
    activePage?: "profile" | "data";
    breadcrumbSuffix?: string;
  } = {},
): OrgShellSlots {
  const { breadcrumbSuffix } = options;

  const initials = data.name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const avatar = (
    <div
      className="w-14 h-14 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xl font-bold text-primary/70"
      aria-hidden="true"
    >
      {initials}
    </div>
  );

  const titlePills = (
    <>
      {data.orgType && (
        <Link
          href={`/organizations?type=${data.orgType}`}
          className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider hover:opacity-80 transition-opacity ${
            ORG_TYPE_COLORS[data.orgType] ?? DEFAULT_ORG_TYPE_COLOR
          }`}
        >
          {ORG_TYPE_LABELS[data.orgType] ?? data.orgType}
        </Link>
      )}
      {data.orgStatus && data.orgStatus in ORG_STATUS_COLORS && (
        <span
          className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
            ORG_STATUS_COLORS[data.orgStatus]
          }`}
        >
          {ORG_STATUS_LABELS[data.orgStatus] ?? data.orgStatus}
        </span>
      )}
    </>
  );

  const metadata = (
    <>
      {data.foundedDateStr && (
        <span>
          Founded {formatKBDate(data.foundedDateStr)}
          {data.orgAge && <span suppressHydrationWarning> ({data.orgAge})</span>}
        </span>
      )}
      {data.hqText && <span>HQ: {data.hqText}</span>}
      {data.websiteUrl && (
        <a
          href={safeHref(data.websiteUrl)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-primary hover:text-primary/80 font-medium transition-colors"
        >
          {shortDomain(data.websiteUrl)} &#8599;
        </a>
      )}
    </>
  );

  // Wiki + Data are now reachable via sidebar tabs, no need to duplicate as
  // header pills. Leaving the slot empty (no headerLinks) on organization pages.
  const headerLinks: EntityProfileShellHeaderLink[] = [];

  // Founders are available via the People tab in the sidebar — no need to
  // duplicate them as a header-footer row.
  const headerFooter: React.ReactNode = null;

  const breadcrumbs: Array<{ label: string; href?: string }> = [
    { label: "Organizations", href: "/organizations" },
  ];
  if (breadcrumbSuffix) {
    breadcrumbs.push({ label: data.name, href: `/organizations/${data.id}` });
    breadcrumbs.push({ label: breadcrumbSuffix });
  } else {
    breadcrumbs.push({ label: data.name });
  }

  return {
    entityId: data.id,
    avatar,
    title: data.name,
    aliases: data.aliases,
    titlePills,
    coverage: data.coverageInput
      ? {
          score: computeOrgCoverage(data.coverageInput),
          signals: getOrgSignals(data.coverageInput),
        }
      : undefined,
    verdict: data.verdict ?? null,
    metadata,
    headerLinks,
    headerFooter,
    breadcrumbs,
  };
}
