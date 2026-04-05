import Link from "next/link";
import { ProfileTabs, type ProfileTab } from "./ProfileTabs";
import { EntityDbPage } from "./EntityDbPage";
import { FactBaseEntityBody } from "@/components/factbase/FactBaseEntityBody";
import { getKBEntity } from "@/data/factbase";
import { getTypedEntityById } from "@/data";

/**
 * EntityDataPage — Two-tab data view for any entity directory page.
 *
 * Tab 1: "Organized View" — FactBase structured facts (hero stats, people, facts by category)
 * Tab 2: "Detail View"    — Raw database records from the entity profile viewer
 *
 * Used at /<directory>/<slug>/data (e.g., /organizations/anthropic/data)
 */

interface EntityDataPageProps {
  /** Entity slug (e.g., "anthropic") */
  slug: string;
  /** Directory prefix for back link (e.g., "/organizations") */
  directoryPrefix: string;
  /** Human-readable label for the entity type (e.g., "Organization") */
  entityTypeLabel: string;
}

export async function EntityDataPage({
  slug,
  directoryPrefix,
  entityTypeLabel,
}: EntityDataPageProps) {
  // FactBase entity ID = slug (e.g., "anthropic")
  const fbEntity = getKBEntity(slug);

  // TableBase entity for display name fallback
  const tbEntity = getTypedEntityById(slug);
  const displayName = fbEntity?.name ?? tbEntity?.title ?? slug;

  const backHref = `${directoryPrefix}/${slug}`;

  const tabs: ProfileTab[] = [
    {
      id: "organized",
      label: "Organized View",
      content: (
        <FactBaseEntityBody entityId={slug} />
      ),
    },
    {
      id: "detail",
      label: "Detail View",
      content: (
        <EntityDbPage
          slug={slug}
          backHref={backHref}
          backLabel={`Back to ${entityTypeLabel} profile`}
        />
      ),
    },
  ];

  return (
    <div>
      {/* Breadcrumbs */}
      <nav className="text-sm text-muted-foreground mb-4">
        <Link href={directoryPrefix} className="hover:underline">
          {entityTypeLabel}s
        </Link>
        <span className="mx-1.5">/</span>
        <Link href={backHref} className="hover:underline">
          {displayName}
        </Link>
        <span className="mx-1.5">/</span>
        <span>Data</span>
      </nav>

      {/* Title */}
      <h1 className="text-2xl font-extrabold tracking-tight mb-6">
        {displayName} — Data
      </h1>

      {/* Tabs */}
      <ProfileTabs tabs={tabs} ariaLabel="Data views" />
    </div>
  );
}
