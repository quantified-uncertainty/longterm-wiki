import { permanentRedirect } from "next/navigation";

interface PageProps {
  params: Promise<{ id: string }>;
}

export default async function LegacySourcePage({ params }: PageProps) {
  const { id } = await params;
  permanentRedirect(`/resources/${id}`);
}
