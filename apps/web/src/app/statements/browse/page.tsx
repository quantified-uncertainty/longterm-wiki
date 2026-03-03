import type { Metadata } from "next";
import { Suspense } from "react";
import {
  fetchAllStatements,
  fetchAllProperties,
  buildEntityNameMap,
} from "../components/statements-data";
import { StatementsExplorer } from "./statements-explorer";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Browse Statements | Longterm Wiki",
  description:
    "Search and filter all structured facts and attributed claims across entities.",
};

export default async function BrowseStatementsPage() {
  const [statements, properties] = await Promise.all([
    fetchAllStatements(),
    fetchAllProperties(),
  ]);

  const entities = [
    ...new Set(statements.map((s) => s.subjectEntityId)),
  ].sort();
  const categories = [
    ...new Set(properties.map((p) => p.category)),
  ].sort();
  const propertyOptions = properties
    .filter((p) => p.statementCount > 0)
    .sort((a, b) => a.label.localeCompare(b.label))
    .map((p) => ({ id: p.id, label: p.label }));

  const entityNames = buildEntityNameMap(entities);

  return (
    <div>
      <h1 className="text-2xl font-bold mb-2">Browse Statements</h1>
      <p className="text-muted-foreground mb-4">
        Search and filter{" "}
        <span className="font-medium text-foreground">
          {statements.length.toLocaleString()}
        </span>{" "}
        statements across all entities. Click a row to expand details.
      </p>
      <Suspense>
        <StatementsExplorer
          statements={statements}
          properties={properties}
          entityNames={entityNames}
          entities={entities}
          categories={categories}
          propertyOptions={propertyOptions}
        />
      </Suspense>
    </div>
  );
}
