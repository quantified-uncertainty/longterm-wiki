import { notFound } from "next/navigation";
import Link from "next/link";
import { Breadcrumbs } from "./Breadcrumbs";
import { EntityDbPage } from "./EntityDbPage";
import { FactBaseEntityBody } from "@/components/factbase/FactBaseEntityBody";
import { getKBEntity } from "@/data/factbase";
import { getTypedEntityById } from "@/data";
import { DataViewTabs } from "./DataViewTabs";

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
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <Breadcrumbs
        items={[
          { label: `${entityTypeLabel}s`, href: directoryPrefix },
          { label: displayName, href: backHref },
          { label: "Data" },
        ]}
      />

      <div className="mb-8">
        <h1 className="text-2xl font-extrabold tracking-tight">
          {displayName}
          <span className="font-normal text-muted-foreground/60"> — Data</span>
        </h1>
        <p className="mt-1.5 text-sm text-muted-foreground">
          Structured facts and database records for this {entityTypeLabel.toLowerCase()}.
        </p>
      </div>

      <DataViewTabs
        structuredContent={structuredContent}
        databaseContent={databaseContent}
      />

      <div className="mt-10 pt-6 border-t border-border/40">
        <Link
          href={backHref}
          className="text-sm text-muted-foreground hover:text-foreground transition-colors"
        >
          &larr; Back to {displayName} profile
        </Link>
      </div>
    </div>
  );
}
