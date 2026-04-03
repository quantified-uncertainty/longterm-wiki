import { permanentRedirect } from "next/navigation";

export default async function SourcesPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const tab = typeof params.tab === "string" ? params.tab : undefined;

  // Preserve known tab values as query params on the target
  if (tab) {
    permanentRedirect(`/resources?tab=${encodeURIComponent(tab)}`);
  }
  permanentRedirect("/resources");
}
