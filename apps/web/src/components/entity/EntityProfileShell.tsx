import Link from "next/link";
import { cn } from "@lib/utils";
import {
  Breadcrumbs,
  ProfileTabs,
  type ProfileTab,
  type ProfileTabGroup,
} from "@/components/directory";
import { CoveragePopover } from "@/components/coverage/CoveragePopover";
import { SourcingDot } from "@/components/sourcing/SourcingDot";
import { recordVerdictToStatus } from "@/components/sourcing/sourcing-status";

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
  /**
   * @deprecated QUA-418 — no longer used. Entity-level rollup pages are
   * deferred to QUA-408 Phase 2. Kept in the interface so callers don't
   * need to churn; safe to remove when a caller cleanup ships.
   */
  entityId?: string;
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
   * Orientation for the tab nav. `"horizontal"` (default) renders a top tab row
   * above the body; `"vertical"` renders a grouped left-side nav with content
   * in the right column. The `sidebar` slot is ignored in vertical layout.
   */
  tabsLayout?: "horizontal" | "vertical";
  /** Ordered group metadata for vertical tab nav. See `ProfileTabGroup`. */
  tabGroups?: ProfileTabGroup[];
  /**
   * Body content for the main column. Used when the page has no tabs, or
   * when tabs are passed and additional content should render below them.
   */
  children?: React.ReactNode;
  /**
   * Right-hand sidebar. When non-null, the main body renders in a 3-col grid
   * (main col = 2/3, sidebar = 1/3). When absent, body is full-width. Ignored
   * when `tabsLayout === "vertical"` — the left nav takes the sidebar slot.
   */
  sidebar?: React.ReactNode;
}

export function EntityProfileShell({
  breadcrumbs,
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
  tabsLayout = "horizontal",
  tabGroups,
  children,
  sidebar,
}: EntityProfileShellProps) {
  const hasTabs = tabs && tabs.length > 0;
  const isVerticalTabs = tabsLayout === "vertical" && hasTabs;

  const horizontalBody = (
    <>
      {hasTabs && <ProfileTabs tabs={tabs} ariaLabel={tabsAriaLabel} />}
      {children}
    </>
  );

  const verticalTabsBlock = hasTabs ? (
    <ProfileTabs
      tabs={tabs}
      ariaLabel={tabsAriaLabel}
      layout="vertical"
      groups={tabGroups}
    />
  ) : null;

  return (
    <div
      className={cn(
        "mx-auto px-6 py-8 overflow-x-hidden",
        isVerticalTabs ? "max-w-[82rem]" : "max-w-[70rem]",
      )}
    >
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
              {verdict !== undefined && (
                <SourcingDot
                  status={recordVerdictToStatus(verdict ?? null)}
                  originalVerdict={verdict ?? null}
                  size="md"
                  // QUA-418: no href — "entity" is not a real record_type in
                  // VALID_RECORD_TYPES, so /sourcing/entity/<id> always 404s.
                  // Entity-level rollup pages are deferred to QUA-408 Phase 2.
                />
              )}
              {(metadata || (headerLinks && headerLinks.length > 0)) && (
                <div className="ml-auto flex items-center gap-3 text-sm text-muted-foreground flex-wrap">
                  {metadata}
                  {headerLinks && headerLinks.length > 0 && (
                    <span className="flex items-center gap-1.5">
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

            {headerFooter && <div className="mt-1">{headerFooter}</div>}
          </div>
        </div>
      </div>

      {statCards && <div className="mb-8">{statCards}</div>}

      {isVerticalTabs ? (
        <>
          {verticalTabsBlock}
          {children}
        </>
      ) : sidebar != null ? (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-2 min-w-0">{horizontalBody}</div>
          <div className="space-y-8">{sidebar}</div>
        </div>
      ) : (
        horizontalBody
      )}
    </div>
  );
}
