import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getAllNumericIds,
  numericIdToSlug,
  slugToNumericId,
  getRawMdxSource,
} from "@/lib/mdx";
import {
  getEntityById,
  getPageById,
  getEntityPath,
  getBacklinksFor,
  getFactsForEntity,
  getExternalLinks,
} from "@/data";

interface PageProps {
  params: Promise<{ id: string }>;
}

interface ClaimRow {
  id: number;
  entityId: string;
  entityType: string;
  claimType: string;
  claimText: string;
  value: string | null;   // section name
  unit: string | null;    // comma-separated footnote refs
  confidence: string | null;
  sourceQuote: string | null;
  createdAt: string;
  updatedAt: string;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

export async function generateStaticParams() {
  return getAllNumericIds().map((id) => ({ id }));
}

/** Fetch claims for a page from the wiki-server. Returns null if unavailable. */
async function fetchPageClaims(pageId: string): Promise<ClaimRow[] | null> {
  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL;
  const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
  if (!serverUrl) return null;

  try {
    const res = await fetch(
      `${serverUrl}/api/claims/by-entity/${encodeURIComponent(pageId)}`,
      {
        headers: { ...(apiKey ? { "x-api-key": apiKey } : {}) },
        next: { revalidate: 300 },
      }
    );
    if (!res.ok) return null;
    const data = await res.json() as { claims: ClaimRow[] };
    return data.claims ?? null;
  } catch {
    return null;
  }
}

function Section({
  title,
  children,
  defaultOpen = false,
}: {
  title: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="mb-4 border border-gray-200 rounded">
      <summary className="cursor-pointer px-4 py-2 bg-gray-50 font-semibold text-sm select-none hover:bg-gray-100">
        {title}
      </summary>
      <div className="p-4 overflow-x-auto">{children}</div>
    </details>
  );
}

function JsonDump({ data }: { data: unknown }) {
  return (
    <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto max-h-[600px] overflow-y-auto whitespace-pre-wrap break-words">
      {JSON.stringify(data, null, 2)}
    </pre>
  );
}

function ConfidenceBadge({ confidence }: { confidence: string | null }) {
  const val = confidence ?? "unverified";
  const colorMap: Record<string, string> = {
    verified: "bg-green-100 text-green-800",
    unverified: "bg-yellow-100 text-yellow-800",
    unsourced: "bg-red-100 text-red-800",
  };
  const cls = colorMap[val] ?? "bg-gray-100 text-gray-800";
  return (
    <span className={`inline-block px-1.5 py-0.5 rounded text-xs font-medium ${cls}`}>
      {val}
    </span>
  );
}

function ClaimsSection({ claims }: { claims: ClaimRow[] }) {
  // Summary counts by confidence
  const byConfidence: Record<string, number> = {};
  for (const c of claims) {
    const key = c.confidence ?? "unverified";
    byConfidence[key] = (byConfidence[key] ?? 0) + 1;
  }

  // Group by section
  const sections = [...new Set(claims.map(c => c.value ?? "Unknown"))];

  return (
    <div>
      {/* Summary bar */}
      <div className="flex gap-3 mb-4 flex-wrap">
        {Object.entries(byConfidence).map(([conf, count]) => (
          <div key={conf} className="flex items-center gap-1">
            <ConfidenceBadge confidence={conf} />
            <span className="text-xs text-gray-600">{count}</span>
          </div>
        ))}
        <span className="text-xs text-gray-500 ml-auto">{claims.length} total claims</span>
      </div>

      {/* Section heatmap */}
      {sections.length > 1 && (
        <div className="mb-4">
          <p className="text-xs font-medium text-gray-600 mb-2">Section breakdown:</p>
          <div className="flex flex-wrap gap-2">
            {sections.map(section => {
              const sectionClaims = claims.filter(c => (c.value ?? "Unknown") === section);
              const verifiedCount = sectionClaims.filter(c => c.confidence === "verified").length;
              const pct = sectionClaims.length > 0 ? Math.round((verifiedCount / sectionClaims.length) * 100) : 0;
              const heatColor = pct >= 70 ? "bg-green-100 border-green-300"
                : pct >= 40 ? "bg-yellow-100 border-yellow-300"
                : "bg-red-100 border-red-300";
              return (
                <span key={section} className={`text-xs px-2 py-1 rounded border ${heatColor}`}>
                  {section.slice(0, 30)} ({verifiedCount}/{sectionClaims.length})
                </span>
              );
            })}
          </div>
        </div>
      )}

      {/* Claims table */}
      <table className="text-xs w-full border-collapse">
        <thead>
          <tr className="border-b text-left bg-gray-50">
            <th className="p-2 w-1/2">Claim</th>
            <th className="p-2">Type</th>
            <th className="p-2">Confidence</th>
            <th className="p-2">Section</th>
            <th className="p-2">Citations</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((claim) => (
            <tr key={claim.id} className="border-b hover:bg-gray-50">
              <td className="p-2 max-w-[400px]">
                <span title={claim.claimText}>{claim.claimText}</span>
                {claim.sourceQuote && (
                  <p className="text-gray-400 italic mt-0.5 truncate" title={claim.sourceQuote}>
                    &ldquo;{claim.sourceQuote.slice(0, 80)}&rdquo;
                  </p>
                )}
              </td>
              <td className="p-2 font-mono">{claim.claimType}</td>
              <td className="p-2">
                <ConfidenceBadge confidence={claim.confidence} />
              </td>
              <td className="p-2 text-gray-600 max-w-[120px] truncate" title={claim.value ?? ""}>
                {claim.value ?? "—"}
              </td>
              <td className="p-2 font-mono">
                {claim.unit ? claim.unit.split(",").map(ref => `[^${ref.trim()}]`).join(" ") : "—"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default async function WikiInfoPage({ params }: PageProps) {
  const { id } = await params;

  let slug: string | null;
  let numericId: string | null;

  if (isNumericId(id)) {
    numericId = id.toUpperCase();
    slug = numericIdToSlug(numericId);
  } else {
    slug = id;
    numericId = slugToNumericId(id);
  }

  if (!slug) notFound();

  const entity = getEntityById(slug);
  const pageData = getPageById(slug);
  const entityPath = getEntityPath(slug);
  const backlinks = getBacklinksFor(slug);
  const facts = getFactsForEntity(slug);
  const externalLinks = getExternalLinks(slug);
  const rawMdx = getRawMdxSource(slug);
  const claims = await fetchPageClaims(slug);

  const title = entity?.title || pageData?.title || slug;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      <div className="mb-6">
        <div className="flex items-center gap-3 mb-1">
          <h1 className="text-2xl font-bold">{title}</h1>
          <span className="text-sm text-gray-500 font-mono">
            {slug}
            {numericId && ` (${numericId})`}
          </span>
        </div>
        <div className="flex gap-3 text-sm">
          <Link
            href={`/wiki/${numericId || slug}`}
            className="text-blue-600 hover:underline"
          >
            &larr; Back to page
          </Link>
          {entityPath && (
            <span className="text-gray-400">Path: {entityPath}</span>
          )}
        </div>
      </div>

      <Section title="Page Metadata" defaultOpen>
        {pageData ? <JsonDump data={pageData} /> : <p className="text-sm text-gray-500">No page data found for &quot;{slug}&quot;</p>}
      </Section>

      <Section title="Entity Data" defaultOpen>
        {entity ? <JsonDump data={entity} /> : <p className="text-sm text-gray-500">No entity found for &quot;{slug}&quot;</p>}
      </Section>

      <Section title={`Claims ${claims && claims.length > 0 ? `(${claims.length})` : ""}`}>
        {claims === null ? (
          <p className="text-sm text-gray-500">
            Claims data unavailable (wiki-server offline or not configured).{" "}
            <span className="font-mono text-xs">Set LONGTERMWIKI_SERVER_URL to enable.</span>
          </p>
        ) : claims.length === 0 ? (
          <p className="text-sm text-gray-500">
            No claims extracted yet. Run:{" "}
            <code className="text-xs bg-gray-100 px-1 py-0.5 rounded">pnpm crux claims extract {slug}</code>
          </p>
        ) : (
          <ClaimsSection claims={claims} />
        )}
      </Section>

      <Section title={`Canonical Facts (${Object.keys(facts).length})`}>
        {Object.keys(facts).length > 0 ? (
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">factId</th>
                <th className="p-2">value</th>
                <th className="p-2">numeric</th>
                <th className="p-2">asOf</th>
                <th className="p-2">source</th>
                <th className="p-2">note</th>
                <th className="p-2">computed</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(facts).map(([factId, fact]) => (
                <tr key={factId} className="border-b">
                  <td className="p-2 font-mono">{factId}</td>
                  <td className="p-2">{fact.value ?? "—"}</td>
                  <td className="p-2">{fact.numeric ?? "—"}</td>
                  <td className="p-2">{fact.asOf ?? "—"}</td>
                  <td className="p-2 max-w-[200px] truncate">{fact.source ?? "—"}</td>
                  <td className="p-2 max-w-[200px] truncate">{fact.note ?? "—"}</td>
                  <td className="p-2">{fact.computed ? "yes" : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-gray-500">No facts for this entity</p>
        )}
      </Section>

      <Section title="External Links">
        {externalLinks ? <JsonDump data={externalLinks} /> : <p className="text-sm text-gray-500">No external links</p>}
      </Section>

      <Section title={`Backlinks (${backlinks.length})`}>
        {backlinks.length > 0 ? (
          <table className="text-xs w-full border-collapse">
            <thead>
              <tr className="border-b text-left">
                <th className="p-2">id</th>
                <th className="p-2">title</th>
                <th className="p-2">type</th>
                <th className="p-2">relationship</th>
              </tr>
            </thead>
            <tbody>
              {backlinks.map((bl) => (
                <tr key={bl.id} className="border-b">
                  <td className="p-2 font-mono">{bl.id}</td>
                  <td className="p-2">
                    <Link href={bl.href} className="text-blue-600 hover:underline">
                      {bl.title}
                    </Link>
                  </td>
                  <td className="p-2">{bl.type}</td>
                  <td className="p-2">{bl.relationship ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-gray-500">No backlinks</p>
        )}
      </Section>

      <Section title="Frontmatter">
        {rawMdx ? <JsonDump data={rawMdx.frontmatter} /> : <p className="text-sm text-gray-500">No MDX file found</p>}
      </Section>

      <Section title="Raw MDX Source">
        {rawMdx ? (
          <pre className="text-xs bg-gray-50 p-3 rounded overflow-x-auto max-h-[800px] overflow-y-auto whitespace-pre-wrap break-words font-mono">
            {rawMdx.raw}
          </pre>
        ) : (
          <p className="text-sm text-gray-500">No MDX file found</p>
        )}
      </Section>
    </div>
  );
}
