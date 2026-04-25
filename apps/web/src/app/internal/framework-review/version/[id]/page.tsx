import { VersionReviewContent } from "../../framework-review-content";

export const dynamic = "force-dynamic";

export default async function VersionReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <VersionReviewContent versionId={id} />;
}
