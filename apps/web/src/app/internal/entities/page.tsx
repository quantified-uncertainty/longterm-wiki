import { getAllEntities, getEntityHref, getPageById } from "@/data";
import { EntitiesDataTable } from "./entities-data-table";
import type { EntityDataRow } from "./entities-data-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Entities Dashboard | Longterm Wiki Internal",
};

export default function EntitiesPage() {
  const entities = getAllEntities();

  const rows: EntityDataRow[] = entities.map((e) => ({
    id: e.id,
    numericId: e.numericId,
    type: e.entityType,
    title: e.title,
    description: e.description,
    status: e.status,
    tags: e.tags || [],
    relatedCount: e.relatedEntries?.length || 0,
    hasPage: !!getPageById(e.id),
    lastUpdated: e.lastUpdated,
    href: getEntityHref(e.id),
  }));

  return (
    <article className="prose max-w-none">
      <h1>Entities Dashboard</h1>
      <p className="text-muted-foreground">
        All entities from the YAML data layer. Entities are defined in{" "}
        <code>data/entities/*.yaml</code> and transformed at build time.
      </p>
      <EntitiesDataTable entities={rows} />
    </article>
  );
}
