import { permanentRedirect } from "next/navigation";
import { getTypedEntityById, isRisk } from "@/data";
import { getEntityHref } from "@/data/entity-nav";

export default async function RiskSlugRedirect({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;

  // Try to find the entity and redirect to its wiki page
  const entity = getTypedEntityById(slug);
  if (entity && isRisk(entity) && entity.numericId) {
    permanentRedirect(`/wiki/${entity.numericId}`);
  }

  // Fallback: try entity href resolution
  const href = getEntityHref(slug);
  if (href && !href.startsWith("/risks")) {
    permanentRedirect(href);
  }

  // Last resort: send to research areas
  permanentRedirect("/research-areas");
}
