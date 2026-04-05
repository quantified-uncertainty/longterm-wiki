import type { Metadata } from "next";
import { notFound, permanentRedirect } from "next/navigation";
import { OrgProfileHeader } from "../org-profile-header";
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

  return (
    <div className="max-w-[90rem] mx-auto px-6 py-8">
      <OrgProfileHeader
        data={headerData}
        breadcrumbSuffix="Data"
        activePage="data"
      />

      <OrgDataBody slug={slug} />
    </div>
  );
}
