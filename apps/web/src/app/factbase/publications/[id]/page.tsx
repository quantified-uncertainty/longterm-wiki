import { redirect } from "next/navigation";
import { getAllPublications } from "@/data";

interface PageProps {
  params: Promise<{ id: string }>;
}

// Render on-demand — this is just a redirect page.

export default async function LegacyPublicationPage({ params }: PageProps) {
  const { id } = await params;
  redirect(`/publications/${id}`);
}
