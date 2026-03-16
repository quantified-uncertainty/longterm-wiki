import type { Metadata } from "next";
import { getTypedEntities, getTypedEntityById, isProject } from "@/data";
import { getEntityHref } from "@/data/entity-nav";
import { ProfileStatCard } from "@/components/directory";
import { getKBLatest } from "@/data/factbase";
import { ProjectsTable, type ProjectRow } from "./projects-table";

export const metadata: Metadata = {
  title: "Projects",
  description:
    "Directory of AI safety tools, platforms, forecasting systems, and research projects tracked in the knowledge base.",
};

export default function ProjectsPage() {
  const projects = getTypedEntities().filter(isProject);

  const rows: ProjectRow[] = projects.map((p) => {
    // Resolve org from founded-by KB fact
    let orgName: string | null = null;
    let orgHref: string | null = null;
    const foundedBy = getKBLatest(p.id, "founded-by");
    if (foundedBy?.value.type === "refs" && foundedBy.value.value.length > 0) {
      const orgRef = foundedBy.value.value[0];
      const orgEntity = getTypedEntityById(orgRef);
      if (orgEntity) {
        orgName = orgEntity.title;
        orgHref = getEntityHref(orgEntity.id);
      }
    }

    // Resolve website from KB fact
    const websiteFact = getKBLatest(p.id, "website");
    const website =
      (websiteFact?.value.type === "text" ? websiteFact.value.value : null) ??
      p.projectUrl ??
      p.website ??
      null;

    return {
      id: p.id,
      title: p.title,
      description: p.description ?? null,
      numericId: p.numericId ?? null,
      status: p.projectStatus ?? p.status ?? null,
      website,
      clusters: p.clusters,
      orgName,
      orgHref,
    };
  });

  const withWebsite = rows.filter((r) => r.website).length;
  const withOrg = rows.filter((r) => r.orgName).length;

  const stats = [
    { label: "Projects", value: String(rows.length) },
    { label: "With Website", value: String(withWebsite) },
    { label: "With Organization", value: String(withOrg) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">
          Projects
        </h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          AI safety tools, platforms, forecasting systems, and research
          projects.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard
            key={stat.label}
            label={stat.label}
            value={stat.value}
          />
        ))}
      </div>

      <ProjectsTable rows={rows} />
    </div>
  );
}
