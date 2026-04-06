import { Suspense } from "react";
import { FactBaseEntityBody } from "@/components/factbase/FactBaseEntityBody";
import { EntityDbPage } from "@/components/directory/EntityDbPage";
import { DataViewTabs } from "@/components/directory/DataViewTabs";
import { ClaimsPipelineSummary } from "@/components/entity/claims-pipeline-summary";

/**
 * Body content for the organization data page.
 * Renders the Claims Pipeline summary + Structured Facts / Database Records tabs.
 */
export function OrgDataBody({ slug }: { slug: string }) {
  const structuredContent = <FactBaseEntityBody entityId={slug} skipVerdicts />;
  const databaseContent = (
    <EntityDbPage
      slug={slug}
      backHref={`/organizations/${slug}`}
      backLabel="Back to Organization profile"
      embedded
    />
  );

  return (
    <div className="space-y-6">
      <Suspense>
        <ClaimsPipelineSummary entityId={slug} />
      </Suspense>
      <DataViewTabs
        structuredContent={structuredContent}
        databaseContent={databaseContent}
      />
    </div>
  );
}
