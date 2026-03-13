import { permanentRedirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LegacySourcesPublicationPage({ params }: PageProps) {
  const { id } = await params;
  permanentRedirect(`/publications/${id}`);
}
