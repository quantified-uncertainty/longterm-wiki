import { redirect } from "next/navigation";

export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

/**
 * Redirect /organizations/[slug]/db -> /organizations/[slug]/data?tab=database
 */
export default async function DbRedirectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  redirect(`/organizations/${slug}/data?tab=database`);
}
