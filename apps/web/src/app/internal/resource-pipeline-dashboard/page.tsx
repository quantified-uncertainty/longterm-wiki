import type { Metadata } from "next";
import { ResourcePipelineContent } from "./resource-pipeline-content";

export const metadata: Metadata = {
  title: "Resource Pipeline — Internal",
  description:
    "Per-resource fetch outcomes, citation_content fill rate, and stuck-pipeline diagnostics.",
};

interface PageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}

export default async function ResourcePipelinePage({ searchParams }: PageProps) {
  const params = await searchParams;
  return (
    <article className="prose dark:prose-invert max-w-none px-6 py-8">
      <h1>Resource Pipeline</h1>
      <ResourcePipelineContent searchParams={params} />
    </article>
  );
}
