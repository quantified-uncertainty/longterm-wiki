import { notFound } from "next/navigation";
import { isHiddenPerson } from "@/lib/hidden-people";

/** 404s every /people/<slug>/* route for people on the hidden list. */
export default async function PersonSlugLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (isHiddenPerson(decodeURIComponent(slug))) notFound();
  return children;
}
