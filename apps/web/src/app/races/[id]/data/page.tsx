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

export default async function RaceDataPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return (
    <EntityDataPage
      slug={id}
      directoryPrefix="/races"
      entityTypeLabel="Political Race"
    />
  );
}
