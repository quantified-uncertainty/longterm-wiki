import { Breadcrumbs } from "./Breadcrumbs";
import { ProfileStatCard } from "./ProfileStatCard";

/**
 * Canonical layout for directory **index** pages — `/organizations`,
 * `/grants`, `/ai-models`, `/legislation`, `/projects`, etc. Renders the
 * outer container, optional breadcrumbs, the title + description header,
 * an optional banner slot (for `<DataSourceBanner>`), an optional stat
 * cards row, an optional before-body slot, and the main body.
 *
 * Per-directory pages provide content via slots. Adding a row that should
 * appear on every directory index (a new dot, a new row) is a one-line
 * edit to this file.
 *
 * Sibling to `EntityProfileShell` (QUA-328 / QUA-1005). The detail-page
 * shell handles entity profile pages; this one handles the index pages
 * that list them.
 */

export interface DirectoryIndexShellStat {
  label: string;
  /**
   * Pre-formatted display value. Callers format numbers, currency, dates etc.
   * before passing them in — the shell does not own formatting (see QUA-1006
   * for cross-table cell-formatting standardization).
   */
  value: string;
  sub?: string;
  href?: string;
}

export interface DirectoryIndexShellProps {
  /** Breadcrumbs above the header. */
  breadcrumbs?: Array<{ label: string; href?: string }>;
  /** Page title — rendered as h1. */
  title: string;
  /**
   * Description under the title. ReactNode so callers can pass computed
   * summaries (e.g. `/legislation` builds its description from row data).
   */
  description?: React.ReactNode;
  /**
   * Banner between header and stats — typically a `<DataSourceBanner>`.
   * Omit on pages with no API/local fallback (e.g. `/grants`).
   */
  banner?: React.ReactNode;
  /**
   * Stat cards row. When non-empty, renders a 2/4-col grid of
   * `ProfileStatCard`. Pages that show their stats inside the table
   * (e.g. `/organizations`) leave this empty.
   */
  stats?: DirectoryIndexShellStat[];
  /**
   * Content between stats and main body. Currently only `/grants` uses this
   * (the "By Funder" summary). If a second caller needs the same shape we
   * factor it into a structured prop; for now it stays generic.
   */
  beforeBody?: React.ReactNode;
  /** Main body — usually `<Suspense><SomeTable /></Suspense>`. */
  children?: React.ReactNode;
}

export function DirectoryIndexShell({
  breadcrumbs,
  title,
  description,
  banner,
  stats,
  beforeBody,
  children,
}: DirectoryIndexShellProps) {
  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      {breadcrumbs && breadcrumbs.length > 0 && (
        <Breadcrumbs items={breadcrumbs} />
      )}

      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">{title}</h1>
        {description && (
          <p className="text-muted-foreground text-sm max-w-2xl">
            {description}
          </p>
        )}
      </div>

      {banner}

      {stats && stats.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
          {stats.map((s, i) => (
            <ProfileStatCard
              key={`${i}-${s.label}`}
              label={s.label}
              value={s.value}
              sub={s.sub}
              href={s.href}
            />
          ))}
        </div>
      )}

      {beforeBody}

      {children}
    </div>
  );
}
