import { notFound } from "next/navigation";
import type { Metadata } from "next";
import {
  getAllPublications,
  getPublicationById,
  getResourcesForPublication,
  getPagesForResource,
} from "@/data";
import { CredibilityBadge } from "@/components/wiki/CredibilityBadge";
import {
  PublicationResourcesTable,
  type PublicationResourceRow,
} from "./publication-resources-table";
import {
  ExternalLink,
  Globe,
  FileText,
  BookOpen,
  CheckCircle2,
} from "lucide-react";

interface PageProps {
  params: Promise<{ id: string }>;
}

export async function generateStaticParams() {
  return getAllPublications().map((p) => ({ id: p.id }));
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const { id } = await params;
  const pub = getPublicationById(id);
  if (!pub) return { title: "Publication Not Found" };

  return {
    title: `${pub.name} | Publications | Longterm Wiki`,
    description:
      pub.description || `${pub.name} — publication venue tracked in the wiki.`,
  };
}

const CREDIBILITY_DESCRIPTIONS: Record<number, string> = {
  5: "Gold standard. Rigorous peer review, high editorial standards, and strong institutional reputation.",
  4: "High quality. Established institution or organization with editorial oversight and accountability.",
  3: "Good quality. Reputable source with community review or editorial standards, but less rigorous than peer-reviewed venues.",
  2: "Mixed quality. Some useful content but inconsistent editorial standards. Claims should be verified.",
  1: "Low credibility. Unvetted or unreliable source. Use with caution and always cross-reference.",
};

function formatType(type: string): string {
  return type
    .replace(/_/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

export default async function PublicationDetailPage({ params }: PageProps) {
  const { id } = await params;
  const pub = getPublicationById(id);

  if (!pub) notFound();

  const resources = getResourcesForPublication(pub.id);

  // Collect unique citing pages
  const pageSet = new Set<string>();
  for (const r of resources) {
    for (const pageId of getPagesForResource(r.id)) {
      pageSet.add(pageId);
    }
  }

  const resourceRows: PublicationResourceRow[] = resources.map((r) => ({
    id: r.id,
    title: r.title,
    type: r.type,
    publishedDate: r.published_date ?? null,
    hasSummary: !!r.summary,
    citingPageCount: getPagesForResource(r.id).length,
  }));

  return (
    <div className="max-w-4xl">
      {/* Breadcrumb */}
      <div className="flex items-center gap-2 text-xs text-muted-foreground mb-4">
        <a href="/claims" className="hover:underline">
          Claims
        </a>
        <span className="opacity-30">/</span>
        <a href="/claims/publications" className="hover:underline">
          Publications
        </a>
        <span className="opacity-30">/</span>
        <span className="text-foreground">{pub.name}</span>
      </div>

      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-bold mb-2">{pub.name}</h1>

        <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm text-muted-foreground">
          <span className="inline-flex items-center gap-1 text-xs px-2 py-0.5 rounded bg-muted">
            {formatType(pub.type)}
          </span>
          {pub.peer_reviewed && (
            <span className="inline-flex items-center gap-1 text-xs text-emerald-700 dark:text-emerald-400">
              <CheckCircle2 className="w-3.5 h-3.5" />
              Peer-reviewed
            </span>
          )}
          <CredibilityBadge level={pub.credibility} size="md" showLabel />
          {pub.website && (
            <a
              href={pub.website}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-xs text-blue-600 dark:text-blue-400 hover:underline"
            >
              <ExternalLink className="w-3 h-3" />
              Website
            </a>
          )}
        </div>

        {pub.description && (
          <p className="text-sm text-muted-foreground mt-3">
            {pub.description}
          </p>
        )}
      </div>

      {/* Credibility Rationale */}
      <section className="mb-8 p-4 rounded-lg border border-border bg-card">
        <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
          Credibility Rating
        </h2>
        <div className="flex items-start gap-4">
          <div className="shrink-0 text-center">
            <div className="text-3xl font-bold tabular-nums">
              {pub.credibility}/5
            </div>
            <CredibilityBadge
              level={pub.credibility}
              size="md"
              showLabel
              className="mt-1"
            />
          </div>
          <div className="text-sm text-muted-foreground leading-relaxed">
            {pub.credibility_rationale ||
              CREDIBILITY_DESCRIPTIONS[pub.credibility]}
          </div>
        </div>
      </section>

      {/* Stats */}
      <div className="grid grid-cols-3 gap-3 mb-8">
        <div className="rounded-lg border border-border p-3 text-center">
          <div className="text-2xl font-bold tabular-nums">
            {resources.length}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Resources
          </div>
        </div>
        <div className="rounded-lg border border-border p-3 text-center">
          <div className="text-2xl font-bold tabular-nums">{pageSet.size}</div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Citing pages
          </div>
        </div>
        <div className="rounded-lg border border-border p-3 text-center">
          <div className="text-2xl font-bold tabular-nums">
            {pub.domains.length}
          </div>
          <div className="text-[11px] text-muted-foreground mt-0.5">
            Tracked domains
          </div>
        </div>
      </div>

      {/* Tracked Domains */}
      {pub.domains.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            <Globe className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Tracked Domains
          </h2>
          <div className="flex flex-wrap gap-2">
            {pub.domains.map((domain) => (
              <span
                key={domain}
                className="text-xs px-2.5 py-1 rounded-full border border-border font-mono"
              >
                {domain}
              </span>
            ))}
          </div>
        </section>
      )}

      {/* Resources Table */}
      {resources.length > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-3">
            <FileText className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Resources ({resources.length})
          </h2>
          <PublicationResourcesTable resources={resourceRows} />
        </section>
      )}

      {/* Citing pages */}
      {pageSet.size > 0 && (
        <section className="mb-8">
          <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground mb-2">
            <BookOpen className="w-4 h-4 inline mr-1.5 -mt-0.5" />
            Citing Pages ({pageSet.size})
          </h2>
          <div className="flex flex-wrap gap-2">
            {[...pageSet].sort().map((pageId) => (
              <a
                key={pageId}
                href={`/wiki/${pageId}`}
                className="text-xs px-2.5 py-1 rounded-full border border-border hover:bg-muted transition-colors"
              >
                {pageId}
              </a>
            ))}
          </div>
        </section>
      )}

      {/* Footer */}
      <div className="text-xs text-muted-foreground border-t border-border pt-4 mt-8">
        Publication ID:{" "}
        <code className="px-1 py-0.5 bg-muted rounded">{pub.id}</code>
      </div>
    </div>
  );
}
