import { notFound, redirect } from "next/navigation";
import type { Metadata } from "next";
import Link from "next/link";

import { getKBEntity } from "@/data/factbase";
import { getDirectoryHref } from "@/data";
import { titleCase } from "@/components/wiki/factbase/format";
import { FactBaseEntityBody } from "@/components/factbase/FactBaseEntityBody";

// ─── Rendering mode ──────────────────────────────────────────────────
export const revalidate = 3600;

export async function generateMetadata({
  params,
}: {
  params: Promise<{ entityId: string }>;
}): Promise<Metadata> {
  const { entityId } = await params;

  if (entityId.includes("_")) {
    const normalized = entityId.replace(/_/g, "-");
    if (getKBEntity(normalized)) {
      redirect(`/factbase/entity/${normalized}`);
    }
  }

  const entity = getKBEntity(entityId);
  return {
    title: entity ? `FactBase: ${entity.name}` : `FactBase: ${entityId}`,
    robots: { index: false },
  };
}

export default async function KBEntityPage({
  params,
}: {
  params: Promise<{ entityId: string }>;
}) {
  const { entityId } = await params;

  if (entityId.includes("_")) {
    const normalized = entityId.replace(/_/g, "-");
    if (getKBEntity(normalized)) {
      redirect(`/factbase/entity/${normalized}`);
    }
  }

  const entity = getKBEntity(entityId);
  if (!entity) return notFound();

  const profileHref = getDirectoryHref(entityId);
  const wikiHref = entity.wikiId ? `/wiki/${entity.wikiId}` : null;

  return (
    <div>
      {/* Breadcrumbs */}
      <nav className="text-sm text-muted-foreground mb-4">
        <Link href="/factbase" className="hover:underline">
          FactBase
        </Link>
        <span className="mx-1.5">/</span>
        <span>{entity.name}</span>
      </nav>

      {/* Header */}
      <div className="mb-8">
        <div className="flex items-center gap-3 mb-1.5">
          <h1 className="text-3xl font-extrabold tracking-tight">{entity.name}</h1>
          <span className="text-[11px] px-2.5 py-1 rounded-full bg-primary/10 text-primary font-semibold uppercase tracking-wider">
            {titleCase(entity.type)}
          </span>
        </div>
        {entity.aliases && entity.aliases.length > 0 && (
          <p className="text-sm text-muted-foreground/70 mb-2">
            Also known as: {entity.aliases.join(", ")}
          </p>
        )}
        <div className="flex items-center gap-3 text-sm">
          {profileHref && (
            <Link
              href={profileHref}
              className="inline-flex items-center gap-1 text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Profile page &rarr;
            </Link>
          )}
          {wikiHref && (
            <Link
              href={wikiHref}
              className="inline-flex items-center gap-1 text-primary hover:text-primary/80 font-medium transition-colors"
            >
              Wiki page &rarr;
            </Link>
          )}
        </div>
      </div>

      {/* Body — shared with /data pages */}
      <FactBaseEntityBody entityId={entityId} />
    </div>
  );
}
