import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { buildOrgShellSlots } from "../org-profile-header";
import { EntityProfileShell } from "@/components/entity/EntityProfileShell";
import {
  fetchEntitySourcingSummary,
  rollupVerdictFromSummary,
} from "@/components/entity/entity-sourcing";
import { resolveOrgEntity, loadOrgHeaderData } from "../org-data";
import { OrgDataBody } from "./org-data-body";

export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

export const metadata: Metadata = {
  title: "Data",
  robots: { index: false },
};

export default async function OrgDataPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  const result = resolveOrgEntity(slug);
  if (!result) return notFound();
  if ("redirect" in result) permanentRedirect(`/organizations/${result.redirect}/data`);

  const { entity } = result;
  const headerData = loadOrgHeaderData(entity, slug);
  const entityStableId = entity.stableId ?? entity.id;
  const sourcingSummary = await fetchEntitySourcingSummary([entity.id, entityStableId, slug]);
  const rollupVerdict = rollupVerdictFromSummary(sourcingSummary);

  const shellSlots = buildOrgShellSlots(
    { ...headerData, verdict: rollupVerdict },
    { activePage: "data", breadcrumbSuffix: "Data" },
  );

  return (
    <EntityProfileShell {...shellSlots}>
      <OrgDataBody slug={slug} />
    </EntityProfileShell>
  );
}
