import { permanentRedirect } from "next/navigation";
import { getOrgSlugs } from "@/app/organizations/org-utils";

export function generateStaticParams() {
  return getOrgSlugs().map((slug) => ({ slug }));
}

/**
 * The /organizations/[slug]/funding subpage is now handled by the Funding tab
 * on the main org profile page. Redirect there.
 */
export default async function OrgFundingPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  permanentRedirect(`/organizations/${slug}`);
}
