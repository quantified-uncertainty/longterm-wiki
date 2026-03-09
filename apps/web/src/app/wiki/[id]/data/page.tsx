import { notFound } from "next/navigation";
import Link from "next/link";
import {
  getAllNumericIds,
  numericIdToSlug,
  slugToNumericId,
} from "@/lib/mdx";
import {
  getPageById,
  getEntityPath,
  getBacklinksFor,
  getExternalLinks,
  getEntityHref,
} from "@/data";

interface PageProps {
  params: Promise<{ id: string }>;
}

function isNumericId(id: string): boolean {
  return /^E\d+$/i.test(id);
}

// Opt out of static generation — these pages are debug/internal tools.
export const dynamicParams = true;

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

  const pageData = getPageById(slug);
  const entityPath = getEntityPath(slug);
  const backlinks = getBacklinksFor(slug);
  const externalLinks = getExternalLinks(slug);

  const title = pageData?.title || slug;
  const entityType = pageData?.entityType || null;

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
            {backlinks.length} backlinks
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

      <Section
        title="Page Record"
        subtitle="database.json — merged from MDX frontmatter + Entity YAML + computed metrics at build time"
        defaultOpen
      >
        {pageData
          ? <JsonDump data={pageData} />
          : <p className="text-sm text-gray-500">No compiled record found for &quot;{slug}&quot;</p>}
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

    </div>
  );
}
