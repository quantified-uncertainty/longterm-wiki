import { permanentRedirect } from "next/navigation";

// Dynamic rendering — this page only redirects, no need to pre-render 256 pages.
export const dynamic = "force-dynamic";

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
