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
  getFactsForEntityWithFallback,
  getExternalLinks,
  getFootnoteIndex,
  getResourceById,
  getResourceCredibility,
} from "@/data";
import type { FootnoteIndexEntry } from "@/data";
import { fetchFromWikiServer } from "@lib/wiki-server";
import type { ClaimRow, GetClaimsResult } from "@wiki-server/api-types";

interface PageProps {
  params: Promise<{ id: string }>;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

export async function generateStaticParams() {
  return getAllNumericIds().map((id) => ({ id }));
}

/** Fetch claims for a page from the wiki-server. Returns null if unavailable. */
async function fetchPageClaims(pageId: string): Promise<ClaimRow[] | null> {
  const result = await fetchFromWikiServer<GetClaimsResult>(
    `/api/claims/by-entity/${encodeURIComponent(pageId)}`,
    { revalidate: 300 }
  );
  return result?.claims ?? null;
}

function Section({
  title,
  subtitle,
  children,
  defaultOpen = false,
}: {
  title: string;
  subtitle?: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  return (
    <details open={defaultOpen} className="mb-4 border border-gray-200 rounded">
      <summary className="cursor-pointer px-4 py-2 bg-gray-50 select-none hover:bg-gray-100">
        <span className="font-semibold text-sm">{title}</span>
        {subtitle && (
          <span className="ml-2 text-xs text-gray-400 font-normal">{subtitle}</span>
        )}
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

/** Parse the comma-separated footnote number string from claim.unit */
function parseFootnoteNums(unit: string | null): number[] {
  if (!unit) return [];
  return unit.split(",").map(s => parseInt(s.trim(), 10)).filter(n => !isNaN(n));
}

/** Render a citation badge that links to the source page or URL */
function CitationBadge({ num, fnIndex }: { num: number; fnIndex?: FootnoteIndexEntry }) {
  const entry = fnIndex?.footnotes[num];
  const href = entry?.resourceId
    ? `/source/${entry.resourceId}`
    : entry?.url ?? null;
  const label = `[^${num}]`;

  if (href) {
    return (
      <a
        href={href}
        target={entry?.resourceId ? undefined : "_blank"}
        rel={entry?.resourceId ? undefined : "noopener noreferrer"}
        className="inline-block font-mono text-blue-600 hover:underline mr-1"
        title={entry?.title ?? href}
      >
        {label}
      </a>
    );
  }
  return <span className="inline-block font-mono text-gray-500 mr-1">{label}</span>;
}

/** Credibility dot (1–5 scale) */
function CredDots({ level }: { level: number }) {
  return (
    <span className="inline-flex gap-0.5">
      {[1, 2, 3, 4, 5].map(i => (
        <span
          key={i}
          className={`inline-block w-1.5 h-1.5 rounded-full ${i <= level ? "bg-green-500" : "bg-gray-200"}`}
        />
      ))}
    </span>
  );
}

type RefEntry = { title: string | null; url: string | null; resourceId?: string; domain?: string };
type SourceEntry = RefEntry & { footnoteNum: number; credibility?: number; claimCount: number };

/** Build shared data structures from claims + footnote index */
function buildClaimsData(claims: ClaimRow[], fnIndex?: FootnoteIndexEntry) {
  const byConfidence: Record<string, number> = {};
  for (const c of claims) {
    const key = c.confidence ?? "unverified";
    byConfidence[key] = (byConfidence[key] ?? 0) + 1;
  }

  const sections = [...new Set(claims.map(c => c.value ?? "Unknown"))];

  const refMap = new Map<number, RefEntry>();
  if (fnIndex) {
    for (const [numStr, entry] of Object.entries(fnIndex.footnotes)) {
      refMap.set(parseInt(numStr, 10), {
        title: entry.title,
        url: entry.url,
        resourceId: entry.resourceId,
        domain: entry.url ? (() => { try { return new URL(entry.url!).hostname.replace(/^www\./, ""); } catch { return undefined; } })() : undefined,
      });
    }
  }

  const allFootnoteNums = new Set<number>();
  for (const claim of claims) {
    for (const n of parseFootnoteNums(claim.unit)) allFootnoteNums.add(n);
  }

  const seenUrls = new Set<string>();
  const uniqueSources: SourceEntry[] = [];
  for (const n of allFootnoteNums) {
    const entry = refMap.get(n);
    if (!entry) continue;
    const key = entry.url ?? `footnote-${n}`;
    if (seenUrls.has(key)) continue;
    seenUrls.add(key);
    const resource = entry.resourceId ? getResourceById(entry.resourceId) : undefined;
    const credibility = resource ? getResourceCredibility(resource) : undefined;
    const claimCount = claims.filter(c => parseFootnoteNums(c.unit).includes(n)).length;
    uniqueSources.push({ footnoteNum: n, ...entry, credibility, claimCount });
  }
  uniqueSources.sort((a, b) => b.claimCount - a.claimCount);

  return { byConfidence, sections, refMap, uniqueSources };
}

function ClaimsTable({ claims, fnIndex }: { claims: ClaimRow[]; fnIndex?: FootnoteIndexEntry }) {
  const { byConfidence, sections, refMap } = buildClaimsData(claims, fnIndex);

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

      <table className="text-xs w-full border-collapse">
        <thead>
          <tr className="border-b text-left bg-gray-50">
            <th className="p-2 w-[28%]">Claim</th>
            <th className="p-2 w-[22%]">Source Quote</th>
            <th className="p-2">Type</th>
            <th className="p-2">Confidence</th>
            <th className="p-2">Section</th>
            <th className="p-2">Source</th>
            <th className="p-2">Citations</th>
          </tr>
        </thead>
        <tbody>
          {claims.map((claim) => {
            const footnoteNums = parseFootnoteNums(claim.unit);
            const firstRef = footnoteNums.length > 0 ? refMap.get(footnoteNums[0]) : null;
            return (
              <tr key={claim.id} className="border-b hover:bg-gray-50 align-top">
                <td className="p-2">{claim.claimText}</td>
                <td className="p-2 text-gray-500 italic">
                  {claim.sourceQuote
                    ? <span title={claim.sourceQuote}>&ldquo;{claim.sourceQuote.slice(0, 120)}{claim.sourceQuote.length > 120 ? "…" : ""}&rdquo;</span>
                    : <span className="text-gray-300 not-italic">—</span>}
                </td>
                <td className="p-2 font-mono whitespace-nowrap">{claim.claimType}</td>
                <td className="p-2 whitespace-nowrap">
                  <ConfidenceBadge confidence={claim.confidence} />
                </td>
                <td className="p-2 text-gray-600 max-w-[110px] truncate" title={claim.value ?? ""}>
                  {claim.value ?? "—"}
                </td>
                <td className="p-2 max-w-[140px]">
                  {firstRef ? (
                    firstRef.resourceId ? (
                      <Link href={`/source/${firstRef.resourceId}`} className="text-blue-600 hover:underline truncate block" title={firstRef.title ?? ""}>
                        {firstRef.domain ?? firstRef.title?.slice(0, 25) ?? "—"}
                      </Link>
                    ) : firstRef.url ? (
                      <a href={firstRef.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline truncate block" title={firstRef.title ?? ""}>
                        {firstRef.domain ?? "link"}
                      </a>
                    ) : (
                      <span className="text-gray-400 truncate block">{firstRef.title?.slice(0, 25) ?? "—"}</span>
                    )
                  ) : "—"}
                  {footnoteNums.length > 1 && (
                    <span className="text-gray-400 text-[10px] block">+{footnoteNums.length - 1} more</span>
                  )}
                </td>
                <td className="p-2 whitespace-nowrap">
                  {footnoteNums.length > 0
                    ? footnoteNums.map(n => <CitationBadge key={n} num={n} fnIndex={fnIndex} />)
                    : "—"}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function ReferencesTable({ claims, fnIndex }: { claims: ClaimRow[]; fnIndex?: FootnoteIndexEntry }) {
  const { uniqueSources } = buildClaimsData(claims, fnIndex);

  if (uniqueSources.length === 0) {
    return <p className="text-sm text-gray-500">No references found. Citations may not be indexed yet.</p>;
  }

  return (
    <table className="text-xs w-full border-collapse">
      <thead>
        <tr className="border-b text-left bg-gray-50">
          <th className="p-2">Source</th>
          <th className="p-2">Domain</th>
          <th className="p-2">Claims</th>
          <th className="p-2">Credibility</th>
          <th className="p-2">Links</th>
        </tr>
      </thead>
      <tbody>
        {uniqueSources.map(src => (
          <tr key={src.footnoteNum} className="border-b hover:bg-gray-50">
            <td className="p-2 max-w-[280px]">
              {src.url ? (
                <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline" title={src.url}>
                  {(src.title ?? src.url).slice(0, 70)}{(src.title ?? src.url).length > 70 ? "…" : ""}
                </a>
              ) : (
                <span>{src.title ?? "—"}</span>
              )}
            </td>
            <td className="p-2 text-gray-500">{src.domain ?? "—"}</td>
            <td className="p-2 text-center">{src.claimCount}</td>
            <td className="p-2">
              {src.credibility != null ? <CredDots level={src.credibility} /> : <span className="text-gray-400">—</span>}
            </td>
            <td className="p-2 whitespace-nowrap">
              {src.resourceId && (
                <Link href={`/source/${src.resourceId}`} className="text-blue-600 hover:underline mr-2">
                  source page
                </Link>
              )}
              {src.url && (
                <a href={src.url} target="_blank" rel="noopener noreferrer" className="text-gray-500 hover:underline text-[10px]">
                  ↗ original
                </a>
              )}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
  const facts = (await getFactsForEntityWithFallback(slug)).data;
  const externalLinks = getExternalLinks(slug);
  const rawMdx = getRawMdxSource(slug);
  const fnIndex = getFootnoteIndex(slug);
  const claims = await fetchPageClaims(slug);

  const title = entity?.title || pageData?.title || slug;
  const entityType = entity?.type || pageData?.entityType || null;

  return (
    <div className="max-w-5xl mx-auto px-6 py-8">
      {/* Header */}
      <div className="mb-6">
        <div className="flex items-start gap-3 mb-2">
          <div className="flex-1">
            <h1 className="text-2xl font-bold mb-1">{title}</h1>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-gray-600">
              <span className="font-mono text-gray-500">{slug}</span>
              {entityType && (
                <span className="px-1.5 py-0.5 bg-gray-100 rounded text-xs">{entityType}</span>
              )}
              {entityPath && (
                <span className="text-gray-400 text-xs">Path: {entityPath}</span>
              )}
            </div>
          </div>
          {/* EID — the canonical numeric entity identifier used in URLs and EntityLink refs */}
          {numericId && (
            <div className="shrink-0 flex flex-col items-end gap-1">
              <span className="font-mono text-2xl font-bold text-indigo-700 bg-indigo-50 border border-indigo-200 px-3 py-1 rounded-lg select-all">
                {numericId}
              </span>
              <span className="text-[10px] text-gray-400 uppercase tracking-wide">Entity ID (EID)</span>
            </div>
          )}
        </div>

        <div className="flex flex-wrap gap-4 text-sm mt-3">
          <Link
            href={`/wiki/${numericId || slug}`}
            className="text-blue-600 hover:underline"
          >
            &larr; Back to page
          </Link>
          <span className="text-gray-400">
            {Object.keys(facts).length} facts
            {" · "}
            {backlinks.length} backlinks
            {claims !== null && ` · ${claims.length} claims`}
          </span>
          {pageData?.quality != null && (
            <span className="text-gray-500">
              Quality: <span className="font-medium">{pageData.quality}</span>
            </span>
          )}
          {pageData?.lastUpdated && (
            <span className="text-gray-500">
              Updated: <span className="font-medium">{pageData.lastUpdated}</span>
            </span>
          )}
        </div>
      </div>

      {/*
        Three data sources shown below:

        1. Compiled Page Record — built at `pnpm build-data` by merging:
             MDX frontmatter + Entity YAML + computed metrics
           Stored in: apps/web/src/data/database.json

        2. Entity YAML — canonical entity definition (type, relatedEntries,
             sources, customFields). Source: data/entities/*.yaml

        3. MDX Frontmatter — editorial metadata authored in the .mdx file
             (quality, importance, llmSummary, ratings, etc.)
             Source: content/docs/…
      */}

      <Section
        title="Compiled Page Record"
        subtitle="database.json — merged from MDX frontmatter + Entity YAML + computed metrics at build time"
        defaultOpen
      >
        {pageData
          ? <JsonDump data={pageData} />
          : <p className="text-sm text-gray-500">No compiled record found for &quot;{slug}&quot;</p>}
      </Section>

      <Section
        title="Entity YAML"
        subtitle="data/entities/*.yaml — canonical entity definition (numericId, type, relatedEntries, sources)"
        defaultOpen
      >
        {entity
          ? <JsonDump data={entity} />
          : <p className="text-sm text-gray-500">No entity YAML found for &quot;{slug}&quot; — this page has no associated entity</p>}
      </Section>

      <Section
        title="MDX Frontmatter"
        subtitle={`${pageData?.filePath ?? "content/docs/…"} — raw frontmatter as authored (quality, scores, llmSummary, ratings)`}
      >
        {rawMdx
          ? <JsonDump data={rawMdx.frontmatter} />
          : <p className="text-sm text-gray-500">No MDX file found</p>}
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
          <ClaimsTable claims={claims} fnIndex={fnIndex} />
        )}
      </Section>

      <Section title={`References ${claims && claims.length > 0 ? `(${buildClaimsData(claims, fnIndex).uniqueSources.length})` : ""}`}>
        {claims === null ? (
          <p className="text-sm text-gray-500">
            Claims data unavailable (wiki-server offline or not configured).
          </p>
        ) : claims.length === 0 ? (
          <p className="text-sm text-gray-500">No claims extracted yet — run claims extract first.</p>
        ) : (
          <ReferencesTable claims={claims} fnIndex={fnIndex} />
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
        {externalLinks
          ? <JsonDump data={externalLinks} />
          : <p className="text-sm text-gray-500">No external links</p>}
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
