import { redirect, notFound } from "next/navigation";
import {
  findDivisionByLegacySlug,
  getAllDivisionSlugs,
  getDivisionHref,
  parseDivision,
} from "./division-data";

// Keep generating static params for legacy slugs so old URLs get redirected
export function generateStaticParams() {
  return getAllDivisionSlugs().map((slug) => ({ slug }));
}

interface PageProps {
  params: Promise<{ slug: string }>;
}

export default async function DivisionRedirectPage({ params }: PageProps) {
  const { slug } = await params;
  const record = findDivisionByLegacySlug(slug);

  if (!record) return notFound();

  const division = parseDivision(record);
  const newHref = getDivisionHref(division);

  if (newHref) {
    redirect(newHref);
  }

  // Fallback: if we can't compute the new URL, 404
  return notFound();
}
