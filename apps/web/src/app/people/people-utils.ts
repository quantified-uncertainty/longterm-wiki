/**
 * Shared utilities for /people routes.
 *
 * Personnel data (key-persons, board-seats, career-history) is fetched
 * from PostgreSQL during build and merged into factbase-data.json as KB records.
 *
 * Career data comes from the KB records layer (populated by build-data.mjs
 * from the wiki-server personnel table). Career-history records are keyed
 * by personId, with fields: organization, title, start, end, source, notes.
 */
import {
  getKBRecords,
  getKBEntitySlug,
  getAllKBRecords,
  getKBEntity,
  resolveKBSlug,
  type KBRecordEntry,
} from "@/data/factbase";
import {
  resolveEntityBySlug,
  getEntitySlugs,
} from "@/lib/directory-utils";

/**
 * Check whether a record's person/member field matches a given entity ID.
 *
 * Records from PG store canonical entity IDs (10-char hashes) in their
 * endpoint fields, but records loaded from YAML store slugs (e.g.,
 * "dario-amodei"). This helper handles both formats so that lookups
 * work regardless of the data source.
 */
function matchesPersonField(
  fieldValue: unknown,
  personEntityId: string,
): boolean {
  if (typeof fieldValue !== "string") return false;
  // Direct entity-ID match (PG data)
  if (fieldValue === personEntityId) return true;
  // Slug match (YAML data): resolve the slug to an entity ID
  const resolvedId = resolveKBSlug(fieldValue);
  return resolvedId === personEntityId;
}

// Re-export generic utilities with people-specific signatures
export const resolvePersonBySlug = (slug: string) =>
  resolveEntityBySlug(slug, "person");

export const getPersonSlugs = () => getEntitySlugs("person");

/**
 * Find all key-person records across all organizations that reference this person.
 * Accepts pre-fetched key-person records to avoid redundant KB scans when the
 * caller also needs the data for other lookups (e.g., funding connections).
 */
export function getOrgRolesForPerson(
  personEntityId: string,
  allKeyPersons?: KBRecordEntry[],
): Array<{
  org: { id: string; name: string; type: string };
  record: { key: string; fields: Record<string, unknown> };
}> {
  const records = allKeyPersons ?? getAllKBRecords("key-persons");
  const results: Array<{
    org: { id: string; name: string; type: string };
    record: { key: string; fields: Record<string, unknown> };
  }> = [];

  for (const rec of records) {
    if (!matchesPersonField(rec.fields.person, personEntityId)) continue;

    const orgEntity = getKBEntity(rec.ownerEntityId);
    if (!orgEntity) continue;

    results.push({
      org: {
        id: orgEntity.id,
        name: orgEntity.name,
        type: orgEntity.type ?? "organization",
      },
      record: {
        key: rec.key,
        fields: rec.fields,
      },
    });
  }

  return results;
}

/**
 * Find all board-seat records across all organizations that reference this person.
 * Accepts pre-fetched board-seat records to avoid redundant KB scans when the
 * caller also needs the data for other lookups (e.g., funding connections).
 */
export function getBoardSeatsForPerson(
  personEntityId: string,
  allBoardSeats?: KBRecordEntry[],
): Array<{
  org: { id: string; name: string; type: string };
  record: { key: string; fields: Record<string, unknown> };
}> {
  const records = allBoardSeats ?? getAllKBRecords("board-seats");
  const results: Array<{
    org: { id: string; name: string; type: string };
    record: { key: string; fields: Record<string, unknown> };
  }> = [];

  for (const rec of records) {
    if (!matchesPersonField(rec.fields.member, personEntityId)) continue;

    const orgEntity = getKBEntity(rec.ownerEntityId);
    if (!orgEntity) continue;

    results.push({
      org: {
        id: orgEntity.id,
        name: orgEntity.name,
        type: orgEntity.type ?? "organization",
      },
      record: {
        key: rec.key,
        fields: rec.fields,
      },
    });
  }

  return results;
}

// -- Career history -------------------------------------------------------

export interface CareerHistoryEntry {
  key: string;
  organization: string;
  title: string;
  startDate: string | null;
  endDate: string | null;
  source: string | null;
  notes: string | null;
}

/**
 * Get career history entries for a person.
 * Reads from the KB records layer (career-history collection).
 * Returns entries sorted by start date (most recent first).
 */
export function getCareerHistory(personEntityId: string): CareerHistoryEntry[] {
  const records: KBRecordEntry[] = getKBRecords(
    personEntityId,
    "career-history",
  );

  const entries: CareerHistoryEntry[] = records.map((r) => ({
    key: r.key,
    organization: String(r.fields.organization ?? ""),
    title: String(r.fields.title ?? ""),
    startDate: r.fields.start ? String(r.fields.start) : null,
    endDate: r.fields.end ? String(r.fields.end) : null,
    source: r.fields.source ? String(r.fields.source) : null,
    notes: r.fields.notes ? String(r.fields.notes) : null,
  }));

  // Sort: current roles first, then by start date descending
  entries.sort((a, b) => {
    const endA = a.endDate ? 1 : 0;
    const endB = b.endDate ? 1 : 0;
    if (endA !== endB) return endA - endB;
    const sa = a.startDate ?? "";
    const sb = b.startDate ?? "";
    return sb.localeCompare(sa);
  });

  return entries;
}

// -- Funding connections ---------------------------------------------------

export interface FundingConnection {
  /** Unique key for React rendering */
  key: string;
  /** Grant display name */
  name: string;
  /** Whether this person's org gave or received the grant, or the person directly received it */
  direction: "gave" | "received" | "personal";
  /** The affiliated org through which the connection exists (null for personal grants) */
  viaOrg: { id: string; name: string; slug: string | undefined } | null;
  /** The counterparty (funder for received, recipient for gave) */
  counterparty: { name: string; href: string | null } | null;
  /** Grant amount in USD */
  amount: number | null;
  /** Grant date or period */
  date: string | null;
  /** Grant program name */
  program: string | null;
  /** Grant status */
  status: string | null;
  /** Source URL */
  source: string | null;
}

/**
 * Derive funding connections for a person through their organization affiliations.
 *
 * Strategy:
 * 1. Collect all affiliated org IDs (from career history, key-person records, board seats)
 * 2. Find grants where those orgs are the funder (ownerEntityId) → "gave"
 * 3. Find grants where those orgs are the recipient → "received"
 * 4. Find grants where the person themselves is the recipient → "personal"
 *
 * Deduplicates by composite key (ownerEntityId + record key) to avoid showing
 * the same grant multiple times when a person has multiple affiliations with the same org.
 *
 * Accepts pre-fetched key-person and board-seat records to avoid redundant KB scans
 * when the caller has already loaded them for other purposes.
 */
export function getFundingConnectionsForPerson(
  personEntityId: string,
  prefetchedKeyPersons?: KBRecordEntry[],
  prefetchedBoardSeats?: KBRecordEntry[],
): FundingConnection[] {
  const entity = getKBEntity(personEntityId);
  if (!entity) return [];

  const personSlug = getKBEntitySlug(personEntityId);

  // Collect affiliated org IDs from all relationship types
  const affiliatedOrgIds = new Set<string>();

  // From career history
  const careerRecords = getKBRecords(personEntityId, "career-history");
  for (const r of careerRecords) {
    const orgId = r.fields.organization;
    if (typeof orgId === "string" && orgId) {
      affiliatedOrgIds.add(orgId);
    }
  }

  // From key-person records (org → person references)
  const keyPersonRecords = prefetchedKeyPersons ?? getAllKBRecords("key-persons");
  for (const rec of keyPersonRecords) {
    if (matchesPersonField(rec.fields.person, personEntityId)) {
      affiliatedOrgIds.add(rec.ownerEntityId);
    }
  }

  // From board seats
  const boardSeatRecords = prefetchedBoardSeats ?? getAllKBRecords("board-seats");
  for (const rec of boardSeatRecords) {
    if (matchesPersonField(rec.fields.member, personEntityId)) {
      affiliatedOrgIds.add(rec.ownerEntityId);
    }
  }

  // Build a set of names/slugs to match for personal grants
  const personalMatchNames = new Set<string>([
    personEntityId.toLowerCase(),
    entity.name.toLowerCase(),
    ...(personSlug ? [personSlug.toLowerCase()] : []),
    ...(entity.aliases?.map((a: string) => a.toLowerCase()) ?? []),
  ]);

  // Resolve an org ID to display info
  function resolveOrg(orgId: string) {
    const orgEntity = getKBEntity(orgId);
    if (!orgEntity) return { id: orgId, name: orgId, slug: undefined };
    return {
      id: orgEntity.id,
      name: orgEntity.name,
      slug: getKBEntitySlug(orgEntity.id),
    };
  }

  // Resolve a recipient or funder to a display name + href
  function resolveCounterparty(
    id: string,
  ): { name: string; href: string | null } {
    const e = getKBEntity(id);
    if (e) {
      const slug = getKBEntitySlug(id);
      const href =
        slug && e.type === "organization"
          ? `/organizations/${slug}`
          : slug && e.type === "person"
            ? `/people/${slug}`
            : `/factbase/entity/${id}`;
      return { name: e.name, href };
    }
    // Title-case the slug as fallback
    const name = id
      .replace(/-/g, " ")
      .replace(/\b\w/g, (c) => c.toUpperCase());
    return { name, href: null };
  }

  const allGrants = getAllKBRecords("grants");
  const seen = new Set<string>();
  const connections: FundingConnection[] = [];

  function parseGrantFields(record: KBRecordEntry) {
    const f = record.fields;
    return {
      name: (f.name as string) ?? record.key,
      amount: typeof f.amount === "number" ? f.amount : null,
      date: (f.date as string) ?? (f.period as string) ?? null,
      program: (f.program as string) ?? null,
      status: (f.status as string) ?? null,
      source: (f.source as string) ?? null,
      recipient: (f.recipient as string) ?? null,
    };
  }

  for (const record of allGrants) {
    const compositeKey = `${record.ownerEntityId}-${record.key}`;
    const parsed = parseGrantFields(record);
    const funderOrgId = record.ownerEntityId;
    const recipientRaw = parsed.recipient;

    // Check if funder org is one of person's affiliated orgs → "gave"
    if (affiliatedOrgIds.has(funderOrgId) && !seen.has(compositeKey)) {
      seen.add(compositeKey);
      const recipientInfo = recipientRaw
        ? resolveCounterparty(recipientRaw)
        : null;
      connections.push({
        key: compositeKey,
        name: parsed.name,
        direction: "gave",
        viaOrg: resolveOrg(funderOrgId),
        counterparty: recipientInfo,
        amount: parsed.amount,
        date: parsed.date,
        program: parsed.program,
        status: parsed.status,
        source: parsed.source,
      });
      continue;
    }

    // Check if person themselves is the recipient → "personal"
    if (
      recipientRaw &&
      personalMatchNames.has(recipientRaw.toLowerCase()) &&
      !seen.has(compositeKey)
    ) {
      seen.add(compositeKey);
      connections.push({
        key: compositeKey,
        name: parsed.name,
        direction: "personal",
        viaOrg: null,
        counterparty: resolveCounterparty(funderOrgId),
        amount: parsed.amount,
        date: parsed.date,
        program: parsed.program,
        status: parsed.status,
        source: parsed.source,
      });
      continue;
    }

    // Check if recipient org is one of person's affiliated orgs → "received"
    if (recipientRaw && !seen.has(compositeKey)) {
      // Try to resolve recipient to an entity ID
      let recipientEntityId: string | null = null;
      const recipientEntity = getKBEntity(recipientRaw);
      if (recipientEntity) {
        recipientEntityId = recipientEntity.id;
      } else {
        // Try matching by slug
        for (const orgId of affiliatedOrgIds) {
          const orgEntity = getKBEntity(orgId);
          if (!orgEntity) continue;
          const orgSlug = getKBEntitySlug(orgId);
          const matchNames = new Set([
            orgId.toLowerCase(),
            orgEntity.name.toLowerCase(),
            ...(orgSlug ? [orgSlug.toLowerCase()] : []),
            ...(orgEntity.aliases?.map((a: string) => a.toLowerCase()) ?? []),
          ]);
          if (matchNames.has(recipientRaw.toLowerCase())) {
            recipientEntityId = orgId;
            break;
          }
        }
      }

      if (recipientEntityId && affiliatedOrgIds.has(recipientEntityId)) {
        seen.add(compositeKey);
        connections.push({
          key: compositeKey,
          name: parsed.name,
          direction: "received",
          viaOrg: resolveOrg(recipientEntityId),
          counterparty: resolveCounterparty(funderOrgId),
          amount: parsed.amount,
          date: parsed.date,
          program: parsed.program,
          status: parsed.status,
          source: parsed.source,
        });
      }
    }
  }

  // Sort: by amount descending (nulls last)
  connections.sort((a, b) => {
    const amtA = a.amount ?? -1;
    const amtB = b.amount ?? -1;
    return amtB - amtA;
  });

  return connections;
}
