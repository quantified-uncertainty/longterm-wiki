import { getAllFacts } from "@/data";
import { FactDashboard } from "@/components/internal/FactDashboard";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fact Dashboard | Cairn Internal",
};

export default function FactsPage() {
  const facts = getAllFacts().map((f) => ({
    key: f.key,
    entity: f.entity,
    factId: f.factId,
    value: f.value,
    numeric: f.numeric,
    asOf: f.asOf,
    source: f.source,
    note: f.note,
    computed: f.computed,
    compute: f.compute,
  }));

  return (
    <article className="prose max-w-none">
      <h1>Canonical Facts Dashboard</h1>
      <p className="text-muted-foreground">
        All canonical facts from the YAML fact store, used by the <code>&lt;F&gt;</code> component.
        Facts are defined in <code>data/facts/*.yaml</code>.
      </p>
      <FactDashboard facts={facts} />
    </article>
  );
}
