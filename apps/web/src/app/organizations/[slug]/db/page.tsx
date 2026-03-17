import type { Metadata } from "next";
import { EntityDbPage } from "@components/directory/EntityDbPage";

// Allow any slug — db pages fetch data client-side, no build-time pre-rendering needed
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

export const metadata: Metadata = {
  title: "Database Records",
};

export default async function DbPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return (
    <EntityDbPage
      slug={slug}
      backHref={`/organizations/${slug}`}
      backLabel="Back to Organizations profile"
    />
  );
}
