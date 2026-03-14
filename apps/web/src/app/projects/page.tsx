import type { Metadata } from "next";
import Link from "next/link";
import { getTypedEntities, isProject } from "@/data";
import { ProfileStatCard } from "@/components/directory";
import { getEntityHref, getWikiHref } from "@/data/entity-nav";

export const metadata: Metadata = {
  title: "Projects",
  description:
    "Directory of AI safety tools, platforms, and research projects tracked in the knowledge base.",
};

const STATUS_COLORS: Record<string, string> = {
  active: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
  maintained: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
  beta: "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-300",
  archived: "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-400",
  abandoned: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
};

export default function ProjectsPage() {
  const projects = getTypedEntities().filter(isProject);

  const stats = [
    { label: "Projects", value: String(projects.length) },
    { label: "With Website", value: String(projects.filter((p) => p.projectUrl || p.website).length) },
    { label: "With Status", value: String(projects.filter((p) => p.projectStatus).length) },
  ];

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <div className="mb-8">
        <h1 className="text-3xl font-extrabold tracking-tight mb-2">Projects</h1>
        <p className="text-muted-foreground text-sm max-w-2xl">
          AI safety tools, platforms, forecasting systems, and research projects.
        </p>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 mb-8">
        {stats.map((stat) => (
          <ProfileStatCard key={stat.label} label={stat.label} value={stat.value} />
        ))}
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {projects
          .sort((a, b) => a.title.localeCompare(b.title))
          .map((project) => {
            const wikiHref = project.numericId ? getWikiHref(project.id) : null;
            const url = project.projectUrl || project.website;
            return (
              <div
                key={project.id}
                className="rounded-xl border border-border/60 bg-card p-4 hover:bg-muted/20 transition-colors"
              >
                <div className="flex items-start justify-between gap-2 mb-2">
                  <Link
                    href={`/projects/${project.id}`}
                    className="font-semibold text-sm hover:text-primary transition-colors line-clamp-1"
                  >
                    {project.title}
                  </Link>
                  {project.projectStatus && (
                    <span
                      className={`shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold capitalize ${
                        STATUS_COLORS[project.projectStatus] ?? "bg-gray-100 text-gray-600"
                      }`}
                    >
                      {project.projectStatus}
                    </span>
                  )}
                </div>
                {project.description && (
                  <p className="text-xs text-muted-foreground line-clamp-3 mb-3">
                    {project.description}
                  </p>
                )}
                <div className="flex items-center gap-3 text-xs">
                  {url && (
                    <a
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-primary hover:underline"
                    >
                      Website &#8599;
                    </a>
                  )}
                  {wikiHref && (
                    <Link href={wikiHref} className="text-primary hover:underline">
                      Wiki &rarr;
                    </Link>
                  )}
                </div>
              </div>
            );
          })}
      </div>
    </div>
  );
}
