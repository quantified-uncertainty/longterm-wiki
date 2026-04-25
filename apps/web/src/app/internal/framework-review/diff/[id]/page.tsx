import { DiffReviewContent } from "../../framework-review-content";

export const dynamic = "force-dynamic";

export default async function DiffReviewPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <DiffReviewContent diffId={id} />;
}
