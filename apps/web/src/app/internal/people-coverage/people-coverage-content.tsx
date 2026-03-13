import {
  getTypedEntities,
  isPerson,
  getAllExperts,
  getAllPages,
  getIdRegistry,
} from "@/data";
import { getKBFacts } from "@/data/kb";
import { PeopleCoverageTable, type PersonCoverageRow } from "./people-coverage-table";

/** Check whether a person entity has a wiki page. */
function personHasPage(
  personId: string,
  pageIds: Set<string>,
  slugToNumeric: Record<string, string>,
): boolean {
  if (pageIds.has(personId)) return true;
  const numericId = slugToNumeric[personId];
  return numericId ? pageIds.has(numericId) : false;
}

export function PeopleCoverageContent() {
  // 1. Collect all person entities
  const allEntities = getTypedEntities();
  const people = allEntities.filter(isPerson);

  // 2. Build expert index for positions lookup
  const experts = getAllExperts();
  const expertById = new Map(experts.map((e) => [e.id, e]));

  // 3. Build page ID set
  const pages = getAllPages();
  const pageIdSet = new Set(pages.map((p) => p.id));

  // 4. Build slug → numericId mapping
  const idRegistry = getIdRegistry();

  // 5. Build rows
  const rows: PersonCoverageRow[] = people.map((person) => {
    const kbFacts = getKBFacts(person.id);
    const expert = expertById.get(person.id);

    // KB fact property checks
    const hasRole = kbFacts.some((f) => f.propertyId === "role");
    const hasEmployer = kbFacts.some((f) => f.propertyId === "employed-by");
    const hasBornYear = kbFacts.some((f) => f.propertyId === "born-year");
    const hasNotableFor = kbFacts.some((f) => f.propertyId === "notable-for");

    // Fall back to entity-level data if KB facts are missing
    const hasRoleFallback = hasRole || !!person.role;
    const hasEmployerFallback =
      hasEmployer || !!person.affiliation;

    // Expert positions
    const hasExpertPositions =
      (expert?.positions && expert.positions.length > 0) || false;

    // Wiki page
    const hasWikiPage = personHasPage(person.id, pageIdSet, idRegistry.bySlug);

    // Career history: multiple employed-by facts indicate career history
    const employedByFacts = kbFacts.filter(
      (f) => f.propertyId === "employed-by",
    );
    const hasCareerHistory = employedByFacts.length >= 2;

    // Compute completeness score (out of 8 fields)
    const fields = [
      hasRoleFallback,
      hasEmployerFallback,
      hasBornYear,
      hasNotableFor,
      hasExpertPositions,
      hasWikiPage,
      hasCareerHistory,
      kbFacts.length > 0, // Has any KB facts at all
    ];
    const completenessScore = fields.filter(Boolean).length;

    return {
      id: person.id,
      numericId: person.numericId ?? idRegistry.bySlug[person.id] ?? "",
      name: person.title,
      hasRole: hasRoleFallback,
      hasEmployer: hasEmployerFallback,
      hasBornYear,
      hasNotableFor,
      hasExpertPositions,
      hasWikiPage,
      hasCareerHistory,
      hasKBFacts: kbFacts.length > 0,
      kbFactCount: kbFacts.length,
      completenessScore,
      totalFields: 8,
    };
  });

  // Sort ascending by completeness (least complete first)
  rows.sort((a, b) => a.completenessScore - b.completenessScore);

  // Compute summary stats
  const total = rows.length;
  const pct = (count: number) =>
    total > 0 ? Math.round((count / total) * 100) : 0;

  const withRole = rows.filter((r) => r.hasRole).length;
  const withEmployer = rows.filter((r) => r.hasEmployer).length;
  const withBornYear = rows.filter((r) => r.hasBornYear).length;
  const withNotableFor = rows.filter((r) => r.hasNotableFor).length;
  const withExpertPositions = rows.filter((r) => r.hasExpertPositions).length;
  const withWikiPage = rows.filter((r) => r.hasWikiPage).length;
  const withCareerHistory = rows.filter((r) => r.hasCareerHistory).length;
  const withKBFacts = rows.filter((r) => r.hasKBFacts).length;

  const avgCompleteness =
    total > 0
      ? Math.round(
          (rows.reduce((sum, r) => sum + r.completenessScore, 0) / total / 8) *
            100,
        )
      : 0;

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Data completeness overview for {total} person entities. Shows which
        people have complete structured data across KB facts, expert positions,
        wiki pages, and career history. Sorted by completeness (least complete
        first) to prioritize data gaps.
      </p>

      {/* Summary stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4 my-6">
        <StatCard label="Total People" value={total.toString()} />
        <StatCard label="Avg Completeness" value={`${avgCompleteness}%`} />
        <StatCard
          label="With Wiki Page"
          value={`${withWikiPage} (${pct(withWikiPage)}%)`}
        />
        <StatCard
          label="With KB Facts"
          value={`${withKBFacts} (${pct(withKBFacts)}%)`}
        />
      </div>

      {/* Detailed coverage stats */}
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3 my-4">
        <MiniStat label="Has Role" count={withRole} total={total} />
        <MiniStat label="Has Employer" count={withEmployer} total={total} />
        <MiniStat label="Has Born Year" count={withBornYear} total={total} />
        <MiniStat label="Has Notable For" count={withNotableFor} total={total} />
        <MiniStat
          label="Has Expert Positions"
          count={withExpertPositions}
          total={total}
        />
        <MiniStat label="Has Wiki Page" count={withWikiPage} total={total} />
        <MiniStat
          label="Has Career History"
          count={withCareerHistory}
          total={total}
        />
        <MiniStat label="Has Any KB Facts" count={withKBFacts} total={total} />
      </div>

      <PeopleCoverageTable data={rows} />
    </>
  );
}

// ── Helper Components ────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function MiniStat({
  label,
  count,
  total,
}: {
  label: string;
  count: number;
  total: number;
}) {
  const pct = total > 0 ? Math.round((count / total) * 100) : 0;
  const color =
    pct >= 75
      ? "text-emerald-600"
      : pct >= 50
        ? "text-amber-600"
        : "text-red-500";

  return (
    <div className="flex items-center justify-between rounded-md border border-border/40 px-3 py-2">
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className={`text-sm font-semibold tabular-nums ${color}`}>
        {count}/{total} ({pct}%)
      </span>
    </div>
  );
}
