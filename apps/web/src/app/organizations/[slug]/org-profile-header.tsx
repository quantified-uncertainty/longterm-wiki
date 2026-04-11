import Link from "next/link";
import { Breadcrumbs } from "@/components/directory";
import { CoveragePopover } from "@/components/coverage/CoveragePopover";
import { computeOrgCoverage, getOrgSignals, type OrgCoverageInput } from "@/components/coverage/coverage-score";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";
import {
  formatKBDate,
  shortDomain,
} from "@/components/wiki/factbase/format";
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
 * Shared profile header for organization pages.
 * Renders breadcrumbs, avatar, name, badges, metadata, and founders.
 * Used by both the main profile page and the /data sub-page.
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
  /** Pre-computed coverage scoring input for the popover */
  coverageInput?: OrgCoverageInput;
  /** Aggregate sourcing verdict for the entity (e.g. "confirmed", "contradicted") */
  verdict?: string | null;
}

export function OrgProfileHeader({
  data,
  breadcrumbSuffix,
  activePage,
}: {
  data: OrgHeaderData;
  /** Extra breadcrumb segment after the entity name (e.g., "Data") */
  breadcrumbSuffix?: string;
  /** Which page is currently active: "profile" or "data" */
  activePage?: "profile" | "data";
}) {
  const initials = data.name
    .split(/[\s-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0])
    .join("")
    .toUpperCase();

  const breadcrumbItems: Array<{ label: string; href?: string }> = [
    { label: "Organizations", href: "/organizations" },
  ];
  if (breadcrumbSuffix) {
    breadcrumbItems.push({
      label: data.name,
      href: `/organizations/${data.id}`,
    });
    breadcrumbItems.push({ label: breadcrumbSuffix });
  } else {
    breadcrumbItems.push({ label: data.name });
  }

  return (
    <div className="mb-6">
      <Breadcrumbs items={breadcrumbItems} />

      <div className="flex items-start gap-5">
        {/* Org avatar/icon */}
        <div
          className="shrink-0 w-14 h-14 rounded-xl bg-gradient-to-br from-primary/20 to-primary/5 flex items-center justify-center text-xl font-bold text-primary/70"
          aria-hidden="true"
        >
          {initials}
        </div>
        <div className="min-w-0">
          <div className="flex items-center gap-3 mb-1 flex-wrap">
            <h1 className="text-2xl font-extrabold tracking-tight">
              {data.name}
            </h1>
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
            {data.orgStatus &&
              data.orgStatus in ORG_STATUS_COLORS && (
                <span
                  className={`px-2.5 py-0.5 rounded-full text-[11px] font-semibold uppercase tracking-wider ${
                    ORG_STATUS_COLORS[data.orgStatus]
                  }`}
                >
                  {ORG_STATUS_LABELS[data.orgStatus] ?? data.orgStatus}
                </span>
              )}
            {data.coverageInput && (
              <CoveragePopover
                score={computeOrgCoverage(data.coverageInput)}
                signals={getOrgSignals(data.coverageInput)}
                size="md"
              />
            )}
            <SourcingDot
              status={recordVerdictToStatus(data.verdict)}
              originalVerdict={data.verdict}
              size="md"
              href={getSourcingHref("entity", data.id)}
            />
          </div>
          {data.aliases && data.aliases.length > 0 && (
            <p className="text-xs text-muted-foreground/70 mb-0.5">
              Also known as: {data.aliases.join(", ")}
            </p>
          )}

          <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
            {data.foundedDateStr && (
              <span>
                Founded {formatKBDate(data.foundedDateStr)}
                {data.orgAge && (
                  <span suppressHydrationWarning> ({data.orgAge})</span>
                )}
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

            {/* Page navigation pills */}
            <span className="flex items-center gap-1.5 ml-1">
              {data.wikiHref && (
                <Link
                  href={data.wikiHref}
                  className="px-2.5 py-0.5 rounded-md text-xs font-medium transition-colors border text-muted-foreground border-border/50 hover:bg-muted/50"
                >
                  Wiki page
                </Link>
              )}
              <Link
                href={`/organizations/${data.id}/data`}
                className={`px-2.5 py-0.5 rounded-md text-xs font-medium transition-colors border ${
                  activePage === "data"
                    ? "bg-primary/10 text-primary border-primary/20"
                    : "text-muted-foreground border-border/50 hover:bg-muted/50"
                }`}
              >
                Data
              </Link>
            </span>
          </div>

          {data.founders.length > 0 && (
            <p className="text-sm text-muted-foreground mt-1">
              Founded by{" "}
              {data.founders.map((f, i) => (
                <span key={i}>
                  {i > 0 &&
                    (i === data.founders.length - 1 ? ", and " : ", ")}
                  {f.href ? (
                    <Link
                      href={f.href}
                      className="text-primary hover:underline"
                    >
                      {f.name}
                    </Link>
                  ) : (
                    f.name
                  )}
                </span>
              ))}
            </p>
          )}
        </div>
      </div>
    </div>
  );
}
