import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * QUA-624: `/organizations/[slug]/people` is a guessable deep-link.
 * The People section lives as the `?tab=people` tab on the parent profile,
 * so redirect there to preserve user intent rather than 404.
 */
export default async function OrgPeopleRedirectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  permanentRedirect(`/organizations/${slug}?tab=people`);
}
