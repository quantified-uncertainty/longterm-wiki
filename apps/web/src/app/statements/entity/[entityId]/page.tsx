import { redirect } from "next/navigation";
import { slugToNumericId } from "@/lib/mdx";

interface PageProps {
  params: Promise<{ entityId: string }>;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

/**
 * Redirect standalone entity statements page to the canonical wiki tab.
 *
 * Previously this was a full standalone page showing entity statements.
 * Now consolidated: /wiki/E22/statements is the single canonical URL.
 * This redirect ensures old links and internal references continue to work.
 */
export default async function EntityStatementsPage({ params }: PageProps) {
  const { entityId } = await params;
  const numericId = isNumericId(entityId)
    ? entityId.toUpperCase()
    : slugToNumericId(entityId);
  if (numericId) {
    redirect(`/wiki/${numericId}/statements`);
  }
  // Fall back to slug-based wiki URL if no numeric ID found
  redirect(`/wiki/${entityId}/statements`);
}
