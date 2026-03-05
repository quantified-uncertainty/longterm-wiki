import Link from "next/link";
import { fetchFromWikiServer } from "@lib/wiki-server";
import { slugToNumericId } from "@/lib/mdx";
import type { ByEntityResult, StatementWithDetails } from "@lib/statement-types";
import { StructuredStatementsTable } from "./StructuredStatementsTable";
import { AttributedStatementsTable } from "./AttributedStatementsTable";
import { StatementSourcesTable } from "./StatementSourcesTable";

function countVerdicts(statements: StatementWithDetails[]) {
  let verified = 0;
  let minorIssues = 0;
  let disputed = 0;
  let unsupported = 0;
  let unchecked = 0;

  for (const s of statements) {
    switch (s.verdict) {
      case "accurate":
        verified++;
        break;
      case "minor_issues":
        minorIssues++;
        break;
      case "inaccurate":
        disputed++;
        break;
      case "unsupported":
        unsupported++;
        break;
      default:
        unchecked++;
        break;
    }
  }

  return { verified, minorIssues, disputed, unsupported, unchecked };
}

/**
 * Server component rendering statements data at the bottom of a wiki page.
 * Fetches from wiki-server with ISR caching. Returns null if no statements.
 */
export async function PageStatementsSection({
  entityId,
}: {
  entityId: string;
}) {
  const result = await fetchFromWikiServer<ByEntityResult>(
    `/api/statements/by-entity?entityId=${encodeURIComponent(entityId)}`,
    { revalidate: 300 }
  );

  if (!result || result.total === 0) return null;

  const { structured, attributed } = result;
  // Split structured into real property-based rows vs text-only claims
  const activeStructuredAll = structured.filter((s) => s.status === "active");
  const activeStructured = activeStructuredAll.filter((s) => s.propertyId);
  const textClaims = activeStructuredAll.filter((s) => !s.propertyId);
  // Merge text-only claims into attributed since they don't fit the Property/Value table
  const activeAttributed = [
    ...attributed.filter((s) => s.status === "active"),
    ...textClaims,
  ];
  const activeAll = [...activeStructured, ...activeAttributed];
  const { verified, minorIssues, disputed, unsupported, unchecked } = countVerdicts(activeAll);
  const numericId = slugToNumericId(entityId);
  const pageRef = numericId ?? entityId;

  // Build summary parts
  const summaryParts: string[] = [];
  if (verified > 0) summaryParts.push(`${verified} verified`);
  if (minorIssues > 0) summaryParts.push(`${minorIssues} minor issues`);
  if (disputed > 0) summaryParts.push(`${disputed} disputed`);
  if (unsupported > 0) summaryParts.push(`${unsupported} unsupported`);
  if (unchecked > 0) summaryParts.push(`${unchecked} unchecked`);

  return (
    <div className="not-prose mt-8 mb-4">
      <div className="flex items-baseline justify-between gap-3 mb-3">
        <h2 className="text-lg font-semibold">Statements</h2>
        <Link
          href={`/wiki/${pageRef}/statements`}
          className="text-xs text-blue-600 hover:underline"
        >
          View all {result.total} &rarr;
        </Link>
      </div>

      <p className="text-xs text-muted-foreground mb-4">
        {activeAll.length} active statements ({summaryParts.join(", ")})
      </p>

      {/* Structured statements */}
      {activeStructured.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-muted-foreground mb-2">
            Structured
            <span className="ml-1.5 text-xs font-normal">({activeStructured.length})</span>
          </h3>
          <StructuredStatementsTable statements={activeStructured} />
        </div>
      )}

      {/* Attributed statements */}
      {activeAttributed.length > 0 && (
        <div className="mb-4">
          <h3 className="text-sm font-semibold text-muted-foreground mb-2">
            Attributed
            <span className="ml-1.5 text-xs font-normal">({activeAttributed.length})</span>
          </h3>
          <AttributedStatementsTable statements={activeAttributed} />
        </div>
      )}

      {/* Sources */}
      {activeAll.some((s) => s.citations.some((c) => c.url)) && (
        <div>
          <h3 className="text-sm font-semibold text-muted-foreground mb-2">Citation Sources</h3>
          <StatementSourcesTable statements={activeAll} />
        </div>
      )}
    </div>
  );
}
