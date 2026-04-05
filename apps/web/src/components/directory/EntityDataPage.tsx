import { notFound } from "next/navigation";
import { Breadcrumbs } from "./Breadcrumbs";
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
  slug: string;
  directoryPrefix: string;
  entityTypeLabel: string;
}

export async function EntityDataPage({
  slug,
  directoryPrefix,
  entityTypeLabel,
}: EntityDataPageProps) {
  const fbEntity = getKBEntity(slug);
  const tbEntity = getTypedEntityById(slug);

  if (!fbEntity && !tbEntity) {
    notFound();
  }

  const displayName = fbEntity?.name ?? tbEntity?.title ?? slug;
  const backHref = `${directoryPrefix}/${slug}`;

  const tabs: ProfileTab[] = [
    {
      id: "organized",
      label: "Organized View",
      content: <FactBaseEntityBody entityId={slug} skipVerdicts />,
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
      <Breadcrumbs
        items={[
          { label: `${entityTypeLabel}s`, href: directoryPrefix },
          { label: displayName, href: backHref },
          { label: "Data" },
        ]}
      />

      <h1 className="text-2xl font-extrabold tracking-tight mb-6">
        {displayName} — Data
      </h1>

      <ProfileTabs tabs={tabs} ariaLabel="Data views" />
    </div>
  );
}
