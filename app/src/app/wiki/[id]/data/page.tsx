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

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

export async function generateStaticParams() {
  return getAllNumericIds().map((id) => ({ id }));
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
