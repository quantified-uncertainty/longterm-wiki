import { getAllFacts, getEntityHref, getFactMetrics } from "@/data";
import { FactDashboard } from "@/components/internal/FactDashboard";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Fact Dashboard | Longterm Wiki Internal",
};

export default function FactsPage() {
  const facts = getAllFacts().map((f) => ({
    key: f.key,
    entity: f.entity,
    factId: f.factId,
    value: f.value,
    numeric: f.numeric,
    low: f.low,
    high: f.high,
    asOf: f.asOf,
    source: f.source,
    note: f.note,
    computed: f.computed,
    compute: f.compute,
    metric: f.metric,
  }));

  // Compute entity hrefs server-side (requires id-registry)
  const entityHrefs: Record<string, string> = {};
  for (const f of facts) {
    if (!entityHrefs[f.entity]) {
      entityHrefs[f.entity] = getEntityHref(f.entity);
    }
  }

  const factMetrics = getFactMetrics();

  return (
    <article className="prose max-w-none">
      <h1>Canonical Facts Dashboard</h1>
      <p className="text-muted-foreground">
        All canonical facts from the YAML fact store, used by the <code>&lt;F&gt;</code> component.
        Facts are defined in <code>data/facts/*.yaml</code>, metrics in <code>data/fact-metrics.yaml</code>.
      </p>
      <FactDashboard facts={facts} entityHrefs={entityHrefs} factMetrics={factMetrics} />
    </article>
  );
}
