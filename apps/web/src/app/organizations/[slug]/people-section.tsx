/**
 * People section for organization profile pages.
 *
 * Fetches personnel data from the wiki-server PG `personnel` table
 * and merges it with FactBase key-persons and board-seats data to display
 * a unified people table with roles, tenure dates, and source-type badges.
 */
import Link from "next/link";
import { formatKBDate, titleCase } from "@/components/wiki/factbase/format";
import {
  fetchFromWikiServer,
  type RpcPersonnelByEntityResult,
  type RpcPersonnelRow,
} from "@/lib/wiki-server";
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
  roleType?: "key-person" | "board" | "career";
}

/** Max page size accepted by the wiki-server personnel endpoint */
const MAX_PERSONNEL_LIMIT = 200;

const VALID_ROLE_TYPES = new Set<string>(["key-person", "board", "career"]);

// ── PG Data Fetching ──────────────────────────────────────────────────

/**
 * Fetch personnel records for an organization from the wiki-server PG table.
 * Returns an empty array if the wiki-server is not configured or unavailable.
 */
export async function fetchPgPersonnel(entityId: string): Promise<RpcPersonnelRow[]> {
  const data = await fetchFromWikiServer<RpcPersonnelByEntityResult>(
    `/api/personnel/by-entity/${encodeURIComponent(entityId)}?limit=${MAX_PERSONNEL_LIMIT}&offset=0`,
    { revalidate: 300, timeoutMs: 10_000 }
  );

  if (data && data.total > data.personnel.length) {
    console.warn(
      `[people-section] Personnel data truncated for entity ${entityId}: showing ${data.personnel.length} of ${data.total} records`
    );
  }

  return data?.personnel ?? [];
}

// ── Merge Logic ──────────────────────────────────────────────────────

/**
 * Convert PG personnel rows into PersonEntry format for merging with
 * existing FactBase key-persons and board-seats data.
 */
/** Matches stableIds: exactly 10 alphanumeric chars with at least one uppercase letter. */
const STABLE_ID_RE = /^(?=.*[A-Z])[A-Za-z0-9]{10}$/;

/** Matches pure numeric IDs (legacy DB PKs). */
const NUMERIC_ID_RE = /^\d+$/;

/**
 * Humanize a raw person identifier for display.
 * Returns null for bare stableIds and numeric PKs (not human-readable).
 * Strips "new:" prefix and converts slug-format IDs to title case.
 */
function humanizePersonId(raw: string): string | null {
  if (STABLE_ID_RE.test(raw) || NUMERIC_ID_RE.test(raw)) return null;
  const cleaned = raw.startsWith("new:") ? raw.slice(4).trim() : raw;
  if (!cleaned) return null;
  // If it looks like a slug (contains hyphens/underscores), humanize it
  if (cleaned.includes("-") || cleaned.includes("_")) {
    return titleCase(cleaned);
  }
  return cleaned;
}

export interface PgPersonnelResult {
  entries: PersonEntry[];
  /** Number of records excluded because the person name could not be resolved */
  unresolvedCount: number;
}

export function pgPersonnelToEntries(rows: RpcPersonnelRow[]): PgPersonnelResult {
  const entries: PersonEntry[] = [];
  let unresolvedCount = 0;

  for (const row of rows) {
    const personRef = row.person;
    // Name resolution priority:
    // 1. Structured ref name (from entity JOIN)
    // 2. Pre-resolved name from API (personResolvedName)
    // 3. Humanized raw personId (strips new:, converts slug to title case)
    // 4. Skip — bare stableIds and numeric PKs are not displayable
    const name =
      personRef?.name ??
      row.personResolvedName ??
      humanizePersonId(row.personId);

    if (!name) {
      unresolvedCount++;
      continue;
    }

    const slug = personRef?.slug ?? undefined;
    const isCurrent = !row.endDate;
    const isFounder = row.isFounder ?? false;
    const isBoard = row.roleType === "board";

    entries.push({
      name,
      title: row.role ?? undefined,
      slug,
      entityType: slug ? "person" : undefined,
      isFounder,
      isBoard,
      isCurrent,
      start: row.startDate ?? undefined,
      end: row.endDate ?? undefined,
      roleType: VALID_ROLE_TYPES.has(row.roleType)
        ? (row.roleType as PersonEntry["roleType"])
        : undefined,
    });
  }

  return { entries, unresolvedCount };
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
  unresolvedCount = 0,
}: {
  people: PersonEntry[];
  unresolvedCount?: number;
}) {
  if (people.length === 0 && unresolvedCount === 0) return null;

  return (
    <section>
      <SectionHeader title="People" count={people.length} />
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
      {unresolvedCount > 0 && (
        <p className="text-xs text-muted-foreground mt-2 px-1">
          {unresolvedCount} additional personnel {unresolvedCount === 1 ? "record" : "records"} pending name resolution
        </p>
      )}
    </section>
  );
}
