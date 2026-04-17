import { ResourcePipelineContent } from "./resource-pipeline-content";

/**
 * Wiki MDX entry point (rendered at /wiki/E2492). Renders the dashboard with
 * default filter state (last 7 days, all fetch statuses). Filter pills inside
 * the content link to /internal/resource-pipeline?... where searchParams are
 * honored — see resource-pipeline/page.tsx.
 */
export function ResourcePipelineDashboardContent() {
  return <ResourcePipelineContent searchParams={{}} />;
}
