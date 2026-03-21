/**
 * People section for organization profile pages.
 *
 * Fetches personnel data from the wiki-server PG `personnel` table
 * and merges it with FactBase key-persons and board-seats data to display
 * a unified people table with roles, tenure dates, and source-type badges.
 */
import Link from "next/link";
import { formatKBDate } from "@/components/wiki/factbase/format";
import { fetchFromWikiServer } from "@/lib/wiki-server";
import { SectionHeader } from "./org-shared";

// ── Types ──────────────────────────────────────────────────────────────

export interface PersonEntry {
  name: string;
  title?: string;
  slug?: string;
  entityType?: string;
  isFounder: boolean;
  isBoard: boolean;
  isCurrent: boolean;
  start?: string;
  end?: string;
  /** Source of the data: "factbase" for KB data, "pg" for PG personnel table */
  source?: "factbase" | "pg";
  roleType?: "key-person" | "board" | "career";
}

/** Shape of the entity ref returned by the personnel API */
interface PersonnelEntityRef {
  entityId: string | null;
  slug: string | null;
  name: string | null;
}

/** Shape of a personnel row from the wiki-server /api/personnel/by-entity/:entityId endpoint */
interface PgPersonnelRow {
  id: string;
  personId: string;
  organizationId: string;
  role: string | null;
  roleType: string;
  startDate: string | null;
  endDate: string | null;
  isFounder: boolean;
  person: PersonnelEntityRef;
  personResolvedName: string | null;
}

/** Response shape from the wiki-server /api/personnel/by-entity/:entityId endpoint */
interface PgPersonnelResponse {
  entityId: string;
  personnel: PgPersonnelRow[];
  total: number;
  limit: number;
  offset: number;
}

// ── PG Data Fetching ──────────────────────────────────────────────────

/**
 * Fetch personnel records for an organization from the wiki-server PG table.
 * Returns an empty array if the wiki-server is not configured or unavailable.
 */
export async function fetchPgPersonnel(entityId: string): Promise<PgPersonnelRow[]> {
  const data = await fetchFromWikiServer<PgPersonnelResponse>(
    `/api/personnel/by-entity/${encodeURIComponent(entityId)}?limit=100&offset=0`,
    { revalidate: 300, timeoutMs: 10_000 }
  );

  return data?.personnel ?? [];
}

// ── Merge Logic ──────────────────────────────────────────────────────

/**
 * Convert PG personnel rows into PersonEntry format for merging with
 * existing FactBase key-persons and board-seats data.
 */
export function pgPersonnelToEntries(rows: PgPersonnelRow[]): PersonEntry[] {
  return rows.map((row) => {
    const personRef = row.person;
    const name = personRef?.name ?? row.personResolvedName ?? row.personId;
    const slug = personRef?.slug ?? undefined;
    const isCurrent = !row.endDate;
    const isFounder = row.isFounder ?? false;
    const isBoard = row.roleType === "board";

    return {
      name,
      title: row.role ?? undefined,
      slug,
      entityType: slug ? "person" : undefined,
      isFounder,
      isBoard,
      isCurrent,
      start: row.startDate ?? undefined,
      end: row.endDate ?? undefined,
      source: "pg" as const,
      roleType: row.roleType as PersonEntry["roleType"],
    };
  });
}

/**
 * Merge PG personnel entries into an existing FactBase people map.
 * Deduplicates by matching on person slug/entity ID, then by name.
 * PG data supplements FactBase data -- if a person already exists in the
 * FactBase map, we enrich rather than overwrite.
 */
export function mergePgPersonnel(
  existingPeople: Map<string, PersonEntry>,
  pgEntries: PersonEntry[]
): void {
  for (const pgEntry of pgEntries) {
    // Try to find existing entry by slug (most reliable)
    let existingKey: string | undefined;

    if (pgEntry.slug) {
      for (const [key, val] of existingPeople) {
        if (val.slug === pgEntry.slug) {
          existingKey = key;
          break;
        }
      }
    }

    // Fall back to name match
    if (!existingKey) {
      for (const [key, val] of existingPeople) {
        if (val.name.toLowerCase() === pgEntry.name.toLowerCase()) {
          existingKey = key;
          break;
        }
      }
    }

    if (existingKey) {
      const existing = existingPeople.get(existingKey)!;
      // Enrich existing entry with PG data if FactBase data is missing
      if (!existing.start && pgEntry.start) existing.start = pgEntry.start;
      if (!existing.end && pgEntry.end) existing.end = pgEntry.end;
      if (!existing.title && pgEntry.title) existing.title = pgEntry.title;
      if (pgEntry.isBoard) existing.isBoard = true;
      if (pgEntry.isFounder) existing.isFounder = true;
    } else {
      // New person from PG — add to map
      const dedupKey = pgEntry.slug ?? pgEntry.name;
      existingPeople.set(dedupKey, pgEntry);
    }
  }
}

// ── Component ──────────────────────────────────────────────────────────

/**
 * Compact unified people table with role badges, tenure dates, and source indicators.
 * Supports data from both FactBase and PG personnel table.
 */
export function PeopleSection({
  people,
  totalCount,
}: {
  people: PersonEntry[];
  totalCount?: number;
}) {
  if (people.length === 0) return null;

  return (
    <section>
      <SectionHeader title="People" count={totalCount ?? people.length} />
      <div className="border border-border rounded-xl overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-xs text-muted-foreground border-b border-border bg-muted/30">
              <th scope="col" className="py-2 px-3 text-left font-medium">
                Name
              </th>
              <th scope="col" className="py-2 px-3 text-left font-medium">
                Role
              </th>
              <th scope="col" className="py-2 px-3 text-left font-medium">
                Tenure
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border/50">
            {people.map((person, i) => {
              const href =
                person.slug && person.entityType
                  ? person.entityType === "organization"
                    ? `/organizations/${person.slug}`
                    : `/people/${person.slug}`
                  : undefined;

              const tenure = person.start
                ? `${formatKBDate(person.start)}${person.end ? ` \u2013 ${formatKBDate(person.end)}` : " \u2013 present"}`
                : "";

              const isFormer = person.isCurrent === false;

              return (
                <tr
                  key={`${person.name}-${i}`}
                  className={`hover:bg-muted/20 transition-colors${isFormer ? " opacity-60" : ""}`}
                >
                  <td className="py-1.5 px-3">
                    <span className="flex items-center gap-1.5">
                      {href ? (
                        <Link
                          href={href}
                          className="font-medium text-foreground hover:text-primary transition-colors"
                        >
                          {person.name}
                        </Link>
                      ) : (
                        <span className="font-medium">{person.name}</span>
                      )}
                      {person.isFounder && (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300">
                          Founder
                        </span>
                      )}
                      {person.isBoard && (
                        <span className="px-1.5 py-0.5 rounded-full text-[10px] font-semibold bg-blue-100 text-blue-700 dark:bg-blue-900/40 dark:text-blue-300">
                          Board
                        </span>
                      )}
                    </span>
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground">
                    {person.title ?? ""}
                  </td>
                  <td className="py-1.5 px-3 text-muted-foreground whitespace-nowrap text-xs">
                    {tenure}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}
