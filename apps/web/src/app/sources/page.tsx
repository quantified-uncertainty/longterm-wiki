import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SourcesOverviewContent } from "@/app/sources/sources-overview-content";

export const metadata: Metadata = {
  title: "Sources",
  description:
    "Citation infrastructure for the AI safety wiki — resources, publications, source checks, and data sources.",
};

const TAB_REDIRECTS: Record<string, string> = {
  resources: "/resources",
  publications: "/publications",
  "source-checks": "/source-checks",
  "data-sources": "/data-sources",
};

export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tab = typeof params.tab === "string" ? params.tab : undefined;

  if (tab && TAB_REDIRECTS[tab]) {
    redirect(TAB_REDIRECTS[tab]);
  }

  return (
    <div>
      <h1 className="text-3xl font-extrabold tracking-tight mb-4">Sources</h1>
      <SourcesOverviewContent />
    </div>
  );
}
