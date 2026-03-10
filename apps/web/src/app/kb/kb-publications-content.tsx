import {
  getAllPublications,
  getResourcesForPublication,
  getPagesForResource,
} from "@/data";
import { KBPublicationsTable } from "./kb-publications-table";
import type { PublicationDataRow } from "./kb-publications-table";

export function KBPublicationsContent() {
  let publications;
  try {
    publications = getAllPublications();
  } catch (error) {
    return (
      <div className="p-8 text-center">
        <p className="text-destructive font-medium">Failed to load publications data</p>
        <p className="text-sm text-muted-foreground mt-2">
          {error instanceof Error ? error.message : "Unknown error"}
        </p>
      </div>
    );
  }

  const rows: PublicationDataRow[] = publications.map((pub) => {
    const resources = getResourcesForPublication(pub.id);
    const pageSet = new Set<string>();
    for (const r of resources) {
      for (const pageId of getPagesForResource(r.id)) {
        pageSet.add(pageId);
      }
    }

    return {
      id: pub.id,
      name: pub.name,
      type: pub.type,
      credibility: pub.credibility,
      peerReviewed: pub.peer_reviewed ?? false,
      resourceCount: resources.length,
      pageCount: pageSet.size,
    };
  });

  const totalResources = rows.reduce((s, r) => s + r.resourceCount, 0);
  const peerReviewedCount = rows.filter((r) => r.peerReviewed).length;
  const avgCredibility =
    rows.length > 0
      ? (rows.reduce((s, r) => s + r.credibility, 0) / rows.length).toFixed(1)
      : "0";

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed mb-6">
        Publication venues tracked in the wiki data layer.{" "}
        <span className="font-medium text-foreground">
          {publications.length}
        </span>{" "}
        publications covering{" "}
        <span className="font-medium text-foreground">{totalResources}</span>{" "}
        resources.
      </p>

      <div className="not-prose grid grid-cols-2 sm:grid-cols-4 gap-3 mb-6">
        <StatCard label="Publications" value={publications.length} />
        <StatCard label="Resources" value={totalResources} />
        <StatCard label="Peer-reviewed" value={peerReviewedCount} />
        <StatCard label="Avg credibility" value={avgCredibility} />
      </div>

      <KBPublicationsTable publications={rows} />
    </>
  );
}

function StatCard({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <div className="rounded-lg border border-border p-3 text-center">
      <div className="text-2xl font-bold tabular-nums">{value}</div>
      <div className="text-[11px] text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}
