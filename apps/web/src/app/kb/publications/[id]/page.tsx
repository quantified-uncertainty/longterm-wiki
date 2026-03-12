import { redirect } from "next/navigation";
import { getAllPublications } from "@/data";

interface PageProps {
  params: Promise<{ id: string }>;
}

export function generateStaticParams() {
  return getAllPublications().map((p) => ({ id: p.id }));
}

export default async function LegacyPublicationPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/sources/publications/${id}`);
}
