import { permanentRedirect } from "next/navigation";

export const dynamic = "force-dynamic";

/**
 * QUA-624: `/people/[slug]/publications` is a guessable deep-link.
 * Person profiles don't currently have a publications tab — redirect to the
 * parent profile so the URL no longer 404s.
 */
export default async function PersonPublicationsRedirectPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  permanentRedirect(`/people/${slug}`);
}
