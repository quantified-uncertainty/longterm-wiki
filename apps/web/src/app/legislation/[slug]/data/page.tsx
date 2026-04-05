import type { Metadata } from "next";
import { EntityDataPage } from "@components/directory/EntityDataPage";

export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

export const metadata: Metadata = {
  title: "Data",
  robots: { index: false },
};

export default async function LegislationDataPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <EntityDataPage
      slug={slug}
      directoryPrefix="/legislation"
      entityTypeLabel="Legislation"
    />
  );
}
