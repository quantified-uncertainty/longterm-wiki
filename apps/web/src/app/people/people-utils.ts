/**
 * Shared utilities for /people routes.
 *
 * Personnel data (key-persons, board-seats, career-history) is fetched
 * from PostgreSQL during build and merged into kb-data.json as KB records.
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
  type KBRecordEntry,
} from "@/data/kb";
import {
  resolveEntityBySlug,
  getEntitySlugs,
} from "@/lib/directory-utils";

// Re-export generic utilities with people-specific signatures
export const resolvePersonBySlug = (slug: string) =>
  resolveEntityBySlug(slug, "person");

export const getPersonSlugs = () => getEntitySlugs("person");

/**
 * Find all key-person records across all organizations that reference this person.
 * Uses getAllKBRecords to scan all orgs' key-persons collections,
 * filtering by fields.person === personEntityId.
 */
export function getOrgRolesForPerson(
  personEntityId: string,
): Array<{
  org: { id: string; name: string; type: string };
  record: { key: string; fields: Record<string, unknown> };
}> {
  const allKeyPersons = getAllKBRecords("key-persons");
  const results: Array<{
    org: { id: string; name: string; type: string };
    record: { key: string; fields: Record<string, unknown> };
  }> = [];

  for (const rec of allKeyPersons) {
    if (rec.fields.person !== personEntityId) continue;

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
 * Uses getAllKBRecords to scan all orgs' board-seats collections,
 * filtering by fields.member === personEntityId.
 */
export function getBoardSeatsForPerson(
  personEntityId: string,
): Array<{
  org: { id: string; name: string; type: string };
  record: { key: string; fields: Record<string, unknown> };
}> {
  const allBoardSeats = getAllKBRecords("board-seats");
  const results: Array<{
    org: { id: string; name: string; type: string };
    record: { key: string; fields: Record<string, unknown> };
  }> = [];

  for (const rec of allBoardSeats) {
    if (rec.fields.member !== personEntityId) continue;

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
 * Get career history records for a person.
 * Career records have ownerEntityId === personEntityId, so we can look up directly.
 */
export function getCareerHistoryForPerson(
  personEntityId: string,
): KBRecordEntry[] {
  return getKBRecords(personEntityId, "career-history");
}

/**
 * Resolve an organization entity ID to a display-friendly object.
 */
export function resolveOrgForCareer(
  orgId: string,
): { id: string; name: string; slug: string | undefined } | null {
  const orgEntity = getKBEntity(orgId);
  if (!orgEntity) return null;
  return {
    id: orgEntity.id,
    name: orgEntity.name,
    slug: getKBEntitySlug(orgEntity.id),
  };
}

// ── Grant / funding connection types and helpers ──────────────────

export interface PersonGrant {
  key: string;
  name: string;
  amount: number | null;
  date: string | null;
  status: string | null;
  source: string | null;
  /** "direct" = person is the named recipient; "via-org" = through an affiliated org */
  connectionType: "direct" | "via-org";
  /** For "via-org" grants, the org through which the grant connects */
  viaOrg: { id: string; name: string; slug: string | undefined } | null;
  /** The funder organization (ownerEntityId of the grant record) */
  funder: { id: string; name: string; slug: string | undefined };
  /** Direction: "received" or "given" (when person leads a funder org) */
  direction: "received" | "given";
  /** Grant recipient display name (for "given" grants) */
  recipientName: string | null;
  recipientHref: string | null;
}

/**
 * Collect all organization IDs affiliated with a person:
 *  - key-person records (org roles)
 *  - board seats
 *  - career history (current positions only, i.e. no end date)
 */
export function getAffiliatedOrgIds(
  personEntityId: string,
): Set<string> {
  const orgIds = new Set<string>();

  // From key-person records
  const orgRoles = getOrgRolesForPerson(personEntityId);
  for (const { org } of orgRoles) {
    orgIds.add(org.id);
  }

  // From board seats
  const boardSeats = getBoardSeatsForPerson(personEntityId);
  for (const { org } of boardSeats) {
    orgIds.add(org.id);
  }

  // From career history (current only -- no end date)
  const career = getCareerHistoryForPerson(personEntityId);
  for (const rec of career) {
    const orgId = rec.fields.organization as string | undefined;
    if (orgId && !rec.fields.end) {
      orgIds.add(orgId);
    }
  }

  return orgIds;
}

/**
 * Find grants where this person is the direct named recipient.
 * Scans all grants across all orgs, matching the recipient field against
 * the person's entity ID, slug, name, and aliases.
 */
export function getDirectGrantsForPerson(
  personEntityId: string,
  personName: string,
  personSlug: string,
  personAliases: string[],
): PersonGrant[] {
  const allGrants = getAllKBRecords("grants");

  const matchNames = new Set<string>([
    personEntityId.toLowerCase(),
    personSlug.toLowerCase(),
    personName.toLowerCase(),
    ...personAliases.map((a) => a.toLowerCase()),
  ]);

  const results: PersonGrant[] = [];

  for (const rec of allGrants) {
    const recipientRaw = rec.fields.recipient as string | undefined;
    if (!recipientRaw) continue;
    if (!matchNames.has(recipientRaw.toLowerCase())) continue;

    const funderEntity = getKBEntity(rec.ownerEntityId);
    results.push({
      key: `${rec.ownerEntityId}-${rec.key}`,
      name: (rec.fields.name as string) ?? rec.key,
      amount: typeof rec.fields.amount === "number" ? rec.fields.amount : null,
      date:
        (rec.fields.date as string) ??
        (rec.fields.period as string) ??
        null,
      status: (rec.fields.status as string) ?? null,
      source: (rec.fields.source as string) ?? null,
      connectionType: "direct",
      viaOrg: null,
      funder: {
        id: rec.ownerEntityId,
        name: funderEntity?.name ?? rec.ownerEntityId,
        slug: getKBEntitySlug(rec.ownerEntityId),
      },
      direction: "received",
      recipientName: null,
      recipientHref: null,
    });
  }

  return results;
}

/**
 * Find grants connected to this person through their affiliated organizations.
 * For each affiliated org:
 *  - "received": grants where the org is the named recipient
 *  - "given": grants where the org is the funder (ownerEntityId)
 */
export function getOrgGrantsForPerson(
  personEntityId: string,
  affiliatedOrgIds: Set<string>,
): PersonGrant[] {
  const allGrants = getAllKBRecords("grants");
  const results: PersonGrant[] = [];

  // Build match sets for each org: name, slug, id, aliases
  const orgMatchSets = new Map<string, Set<string>>();
  for (const orgId of affiliatedOrgIds) {
    const orgEntity = getKBEntity(orgId);
    const matchNames = new Set<string>([orgId.toLowerCase()]);
    if (orgEntity) {
      matchNames.add(orgEntity.name.toLowerCase());
      const slug = getKBEntitySlug(orgId);
      if (slug) matchNames.add(slug.toLowerCase());
    }
    orgMatchSets.set(orgId, matchNames);
  }

  for (const rec of allGrants) {
    // Check if this org is the funder (grants made by affiliated org)
    if (affiliatedOrgIds.has(rec.ownerEntityId)) {
      const funderEntity = getKBEntity(rec.ownerEntityId);
      const recipientId = rec.fields.recipient as string | undefined;
      let recipientName: string | null = null;
      let recipientHref: string | null = null;
      if (recipientId) {
        const recipientEntity = getKBEntity(recipientId);
        if (recipientEntity) {
          recipientName = recipientEntity.name;
          const recipientSlug = getKBEntitySlug(recipientId);
          recipientHref = recipientSlug
            ? (recipientEntity.type === "person"
                ? `/people/${recipientSlug}`
                : `/organizations/${recipientSlug}`)
            : `/kb/entity/${recipientId}`;
        } else {
          // Humanize the slug
          recipientName = recipientId
            .replace(/-/g, " ")
            .replace(/\b\w/g, (c) => c.toUpperCase());
        }
      }

      results.push({
        key: `via-${rec.ownerEntityId}-${rec.key}`,
        name: (rec.fields.name as string) ?? rec.key,
        amount:
          typeof rec.fields.amount === "number" ? rec.fields.amount : null,
        date:
          (rec.fields.date as string) ??
          (rec.fields.period as string) ??
          null,
        status: (rec.fields.status as string) ?? null,
        source: (rec.fields.source as string) ?? null,
        connectionType: "via-org",
        viaOrg: {
          id: rec.ownerEntityId,
          name: funderEntity?.name ?? rec.ownerEntityId,
          slug: getKBEntitySlug(rec.ownerEntityId),
        },
        funder: {
          id: rec.ownerEntityId,
          name: funderEntity?.name ?? rec.ownerEntityId,
          slug: getKBEntitySlug(rec.ownerEntityId),
        },
        direction: "given",
        recipientName,
        recipientHref,
      });
      continue;
    }

    // Check if this org is the recipient (grants received by affiliated org)
    const recipientRaw = rec.fields.recipient as string | undefined;
    if (!recipientRaw) continue;

    for (const [orgId, matchNames] of orgMatchSets) {
      if (!matchNames.has(recipientRaw.toLowerCase())) continue;

      const funderEntity = getKBEntity(rec.ownerEntityId);
      const orgEntity = getKBEntity(orgId);

      results.push({
        key: `via-${orgId}-${rec.key}`,
        name: (rec.fields.name as string) ?? rec.key,
        amount:
          typeof rec.fields.amount === "number" ? rec.fields.amount : null,
        date:
          (rec.fields.date as string) ??
          (rec.fields.period as string) ??
          null,
        status: (rec.fields.status as string) ?? null,
        source: (rec.fields.source as string) ?? null,
        connectionType: "via-org",
        viaOrg: {
          id: orgId,
          name: orgEntity?.name ?? orgId,
          slug: getKBEntitySlug(orgId),
        },
        funder: {
          id: rec.ownerEntityId,
          name: funderEntity?.name ?? rec.ownerEntityId,
          slug: getKBEntitySlug(rec.ownerEntityId),
        },
        direction: "received",
        recipientName: null,
        recipientHref: null,
      });
      break; // Avoid duplicate entries if multiple match names hit
    }
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
