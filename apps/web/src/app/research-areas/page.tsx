import type { Metadata } from "next";
import { getResearchAreasFromPG } from "@/data/tablebase";
import { ResearchAreasTable, type ResearchAreaRow } from "./research-areas-table";

export const metadata: Metadata = {
  title: "Research Areas",
  description:
    "Directory of AI safety research areas — fields, techniques, and programs with key papers, organizations, and grant funding.",
};

export default function ResearchAreasPage() {
  const areas = getResearchAreasFromPG();

  const clustersSet = new Set<string>();
  for (const a of areas) {
    if (a.cluster) clustersSet.add(a.cluster);
  }

  const rows: ResearchAreaRow[] = areas.map((a) => ({
    id: a.id,
    numericId: a.numericId ?? null,
    title: a.title,
    description: a.description ?? null,
    status: a.status,
    cluster: a.cluster ?? null,
    parentAreaId: a.parentAreaId ?? null,
    firstProposedYear: a.firstProposedYear ?? null,
    orgCount: a.orgCount ?? 0,
    paperCount: a.paperCount ?? 0,
    grantCount: a.grantCount ?? 0,
    totalFunding: a.totalFunding ?? "0",
    riskCount: a.riskCount ?? 0,
  }));

  // Summary stats
  const totalAreas = areas.length;
  const activeAreas = areas.filter((a) => a.status === "active").length;
  const emergingAreas = areas.filter((a) => a.status === "emerging").length;
  const clustersCount = clustersSet.size;

  const stats = [
    { label: "Research Areas", value: String(totalAreas) },
    { label: "Active", value: String(activeAreas) },
    { label: "Emerging", value: String(emergingAreas) },
    { label: "Clusters", value: String(clustersCount) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Research Areas
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          AI safety research fields, techniques, and programs — with key papers,
          active organizations, and grant funding data.
        </p>
      </div>

      {/* Summary stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-8">
        {stats.map((stat) => (
          <div
            key={stat.label}
            className="rounded-xl border border-border/60 bg-gradient-to-br from-card to-muted/30 p-4"
          >
            <div className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground/70 mb-1">
              {stat.label}
            </div>
            <div className="text-2xl font-bold tabular-nums tracking-tight">
              {stat.value}
            </div>
          </div>
        ))}
      </div>

      <ResearchAreasTable rows={rows} />
    </div>
  );
}
