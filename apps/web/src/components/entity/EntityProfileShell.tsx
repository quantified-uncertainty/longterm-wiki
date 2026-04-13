import Link from "next/link";
import {
  Breadcrumbs,
  ProfileTabs,
  type ProfileTab,
} from "@/components/directory";
import { CoveragePopover } from "@/components/coverage/CoveragePopover";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";
import { getSourcingHref } from "@/app/sourcing/sourcing-shared";

/**
 * `EntityProfileShell` is the canonical layout for every entity profile page
 * (organizations, people, ai-models, projects, etc.). It renders the outer
 * container, breadcrumbs, header (title + pills + coverage + sourcing
 * rollup badge), optional stat cards, and either a `ProfileTabs` block or free
 * body content, with an optional right-hand sidebar.
 *
 * Per-entity-type pages provide slot content via props. Adding a new item that
 * should appear on all entity pages (a new badge, a new header row, etc.) is a
 * one-line edit to this file.
 *
 * Sourcing rollup badge: pass `verdict` (a raw sourcing verdict string,
 * typically obtained via `fetchEntitySourcingSummary` + `rollupVerdictFromSummary`).
 * The shell renders a single `SourcingDot` from one code path.
 */

export interface EntityProfileShellHeaderLink {
  label: string;
  href: string;
  /** If true, renders as <a target="_blank"> instead of <Link> */
  external?: boolean;
  /** Highlights the link — used for the currently-active sub-page (e.g. Data) */
  active?: boolean;
}

export interface EntityProfileShellProps {
  // ── Navigation ──────────────────────────────────────────────────────
  breadcrumbs: Array<{ label: string; href?: string }>;

  // ── Header ──────────────────────────────────────────────────────────
  /** Entity identifier passed to SourcingDot (`getSourcingHref("entity", entityId)`). */
  entityId: string;
  /** Optional avatar node (e.g. initials circle). Omitted when null/undefined. */
  avatar?: React.ReactNode;
  /** Main entity title. */
  title: string;
  /** Aliases rendered below the title row as "Also known as: ..." */
  aliases?: string[];
  /** Badges/pills rendered on the same row as the title (type, status, etc.). */
  titlePills?: React.ReactNode;
  /**
   * Data-coverage score (1-4) and its signal list. When provided, the shell
   * renders a `CoveragePopover` next to the title row.
   */
  coverage?: { score: number; signals: string[] };
  /**
   * Aggregate sourcing rollup verdict ("confirmed" | "contradicted" | ...).
   * Use `null` for "unchecked"/no data. The shell always renders a SourcingDot
   * so every entity page has a visible sourcing badge.
   */
  verdict?: string | null;
  /** Subtitle/description block rendered immediately below the title row. */
  subtitle?: React.ReactNode;
  /** Metadata row — founded date, HQ, website, etc. */
  metadata?: React.ReactNode;
  /**
   * Links row — wiki page, Data sub-page, external website, etc. Each is
   * rendered as a compact pill.
   */
  headerLinks?: EntityProfileShellHeaderLink[];
  /** Extra content below the header (e.g. founders list). */
  headerFooter?: React.ReactNode;

  // ── Body ────────────────────────────────────────────────────────────
  /** Stat cards row rendered between the header and the main body. */
  statCards?: React.ReactNode;
  /** When provided, the shell renders a `ProfileTabs` block in the main column. */
  tabs?: ProfileTab[];
  tabsAriaLabel?: string;
  /**
   * Body content for the main column. Used when the page has no tabs, or
   * when tabs are passed and additional content should render below them.
   */
  children?: React.ReactNode;
  /**
   * Right-hand sidebar. When non-null, the main body renders in a 3-col grid
   * (main col = 2/3, sidebar = 1/3). When absent, body is full-width.
   */
  sidebar?: React.ReactNode;
}

export function EntityProfileShell({
  breadcrumbs,
  entityId,
  avatar,
  title,
  aliases,
  titlePills,
  coverage,
  verdict,
  subtitle,
  metadata,
  headerLinks,
  headerFooter,
  statCards,
  tabs,
  tabsAriaLabel = "Entity sections",
  children,
  sidebar,
}: EntityProfileShellProps) {
  const hasTabs = tabs && tabs.length > 0;

  const mainContent = (
    <>
      {hasTabs && <ProfileTabs tabs={tabs} ariaLabel={tabsAriaLabel} />}
      {children}
    </>
  );

  return (
    <div className="max-w-[70rem] mx-auto px-6 py-8 overflow-x-hidden">
      <Breadcrumbs items={breadcrumbs} />

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-start gap-5">
          {avatar != null && <div className="shrink-0">{avatar}</div>}
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-3 mb-1 flex-wrap">
              <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
              {titlePills}
              {coverage && (
                <CoveragePopover
                  score={coverage.score}
                  signals={coverage.signals}
                  size="md"
                />
              )}
              <SourcingDot
                status={recordVerdictToStatus(verdict ?? null)}
                originalVerdict={verdict ?? null}
                size="md"
                href={getSourcingHref("entity", entityId)}
              />
            </div>

            {aliases && aliases.length > 0 && (
              <p className="text-xs text-muted-foreground/70 mb-0.5">
                Also known as: {aliases.join(", ")}
              </p>
            )}

            {subtitle && (
              <div className="text-sm text-muted-foreground max-w-3xl leading-relaxed mt-1">
                {subtitle}
              </div>
            )}

            {(metadata || (headerLinks && headerLinks.length > 0)) && (
              <div className="flex items-center gap-3 text-sm text-muted-foreground flex-wrap mt-2">
                {metadata}
                {headerLinks && headerLinks.length > 0 && (
                  <span className="flex items-center gap-1.5 ml-1">
                    {headerLinks.map((link) => {
                      const className = `px-2.5 py-0.5 rounded-md text-xs font-medium transition-colors border ${
                        link.active
                          ? "bg-primary/10 text-primary border-primary/20"
                          : "text-muted-foreground border-border/50 hover:bg-muted/50"
                      }`;
                      if (link.external) {
                        return (
                          <a
                            key={link.label}
                            href={link.href}
                            target="_blank"
                            rel="noopener noreferrer"
                            className={className}
                          >
                            {link.label}
                          </a>
                        );
                      }
                      return (
                        <Link key={link.label} href={link.href} className={className}>
                          {link.label}
                        </Link>
                      );
                    })}
                  </span>
                )}
              </div>
            )}

            {headerFooter && <div className="mt-1">{headerFooter}</div>}
          </div>
        </div>
      </div>

      {statCards && <div className="mb-8">{statCards}</div>}

      {sidebar != null ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 min-w-0">{mainContent}</div>
          <div className="space-y-8">{sidebar}</div>
        </div>
      ) : (
        mainContent
      )}
    </div>
  );
}
