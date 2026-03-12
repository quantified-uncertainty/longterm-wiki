/**
 * Record detail page -- STUB (records infrastructure removed).
 *
 * Records have been migrated to PostgreSQL. This page is kept as a stub
 * so existing links don't 404 — it redirects to the KB explorer.
 */

import { redirect } from "next/navigation";
import type { Metadata } from "next";

export function generateStaticParams() {
  return [];
}

interface PageProps {
  params: Promise<{ recordId: string }>;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { recordId } = await params;
  return {
    title: `Record: ${recordId} (removed)`,
    robots: { index: false },
  };
}

export default async function RecordDetailPage({ params }: PageProps) {
  const _p = await params;
  void _p;
  redirect("/wiki/E1019");
}
