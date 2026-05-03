import { notFound } from "next/navigation";
import { EntityDbPage } from "./EntityDbPage";
import { FactBaseEntityBody } from "@/components/factbase/FactBaseEntityBody";
import { getKBEntity } from "@/data/factbase";
import { getTypedEntityById } from "@/data";
import { DataViewTabs } from "./DataViewTabs";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  fetchEntitySourcingSummary,
  rollupVerdictFromSummary,
} from "@/components/entity/entity-sourcing";

/**
 * EntityDataPage — Two-tab data view for any entity directory page.
 *
 * Tab 1: "Structured Facts" — FactBase structured facts (hero stats, people, facts by category)
 * Tab 2: "Database Records"  — Raw database records from the entity profile viewer (auto-loaded)
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
  const entityId = fbEntity?.id ?? tbEntity?.stableId ?? tbEntity?.id ?? slug;
  const stableId = fbEntity?.stableId ?? tbEntity?.stableId ?? "";

  const sourcingSummary = await fetchEntitySourcingSummary([entityId, stableId, slug]);
  const rollupVerdict = rollupVerdictFromSummary(sourcingSummary);

  const structuredContent = <FactBaseEntityBody entityId={slug} skipVerdicts />;
  const databaseContent = (
    <EntityDbPage
      slug={slug}
      backHref={backHref}
      backLabel={`Back to ${entityTypeLabel} profile`}
      embedded
    />
  );

  return (
    <EntityProfileShell
      breadcrumbs={[
        { label: `${entityTypeLabel}s`, href: directoryPrefix },
        { label: displayName, href: backHref },
        { label: "Data" },
      ]}
      entityId={entityId}
      title={displayName}
      verdict={rollupVerdict}
      subtitle={`Structured facts and database records for this ${entityTypeLabel.toLowerCase()}.`}
      headerLinks={[
        { label: `${entityTypeLabel} profile`, href: backHref },
      ]}
    >
      <DataViewTabs
        structuredContent={structuredContent}
        databaseContent={databaseContent}
      />
    </EntityProfileShell>
  );
}
