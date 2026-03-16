import { notFound, redirect } from "next/navigation";
import { getAllKBRecords, getKBEntitySlug } from "@/data/factbase";

/**
 * Legacy grant detail page — redirects to the org-scoped URL.
 * e.g. /grants/some-grant → /organizations/some-org/grants/some-grant
 */

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function GrantRedirectPage({ params }: PageProps) {
  const { id } = await params;
  const allGrants = getAllKBRecords("grants");
  const record = allGrants.find((r) => r.key === id);

  if (!record) notFound();

  const funderSlug = getKBEntitySlug(record.ownerEntityId);
  if (funderSlug) {
    redirect(`/organizations/${funderSlug}/grants/${id}`);
  }

  // Funder has no org slug — can't redirect, 404
  notFound();
}
