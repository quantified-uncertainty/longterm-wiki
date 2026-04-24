import {
  getKBLatest,
  getKBFacts,
  getKBAllRecordCollections,
  resolveKBSlug,
  getKBRecords,
  getAllKBRecords,
  getEntityEvents,
  type EntityEvent,
} from "@/data/factbase";
import {
  getTypedEntityById,
  getTypedEntities,
  isOrganization,
  isAiModel,
} from "@/data";
import { sortKBRecords, titleCase } from "@/components/wiki/factbase/format";
import { resolveEntityName } from "@/lib/resolve-entity-name";
import type { OrgHeaderData } from "../org-profile-header";

import {
  CURATED_COLLECTIONS,
  numericValue,
  computeOrgAge,
  getLatestFactsByProperty,
  groupByCategory,
  type AuthorRef,
} from "./common";
import type { OrgEntity } from "./entity";
import {
  parseGrantRecord,
  type ReceivedGrant,
} from "./grants";
import { parseDivisionRecord } from "./divisions";
import { parseFundingProgramRecord } from "./funding-programs";
import {
  parsePersonnelRecord,
  parseBoardSeatRecord,
  type ParsedPersonnelRecord,
  type BoardMember,
} from "./personnel";
import {
  parseFundingRoundRecord,
  type ParsedFundingRoundRecord,
} from "./funding-rounds";
import {
  parseInvestmentRecord,
  type ParsedInvestmentRecord,
} from "./investments";
import {
  parseEquityPositionRecord,
  type ParsedEquityPositionRecord,
} from "./equity-positions";
import { parseDilutionStageRecord } from "./dilution-stages";
import { parseCharitablePledgeRecord } from "./charitable-pledges";
import type { RelatedOrg } from "./related-orgs";
import { getOrgResources } from "./resources";
import { buildChartData } from "./charts";

/**
 * Load all data needed for an organization profile page.
 * This is a pure data function — no JSX rendering.
 */
export function loadOrgPageData(entity: OrgEntity, slug: string) {
  // Use URL slug directly — typed entities are keyed by slug, not KB internal IDs
  const typedEntity = getTypedEntityById(slug);
  const orgData = typedEntity && isOrganization(typedEntity) ? typedEntity : null;
  const orgType = orgData?.orgType ?? null;
  const orgStatus = orgData?.orgStatus ?? null;

  // Header facts (description/website come from entity YAML, not KB facts)
  const hqFact = getKBLatest(entity.id, "headquarters");

  // All record collections
  const allCollections = getKBAllRecordCollections(entity.id);

  // Curated collections
  const rawFundingRounds = allCollections["funding-rounds"] ?? [];
  const keyPersons = allCollections["key-persons"] ?? [];
  const investments = allCollections["investments"] ?? [];
  const products = allCollections["products"] ?? [];
  const modelReleases = allCollections["model-releases"] ?? [];
  const safetyMilestones = allCollections["safety-milestones"] ?? [];
  const strategicPartnerships = allCollections["strategic-partnerships"] ?? [];

  // Other (non-curated) collections with entries
  const otherCollections = Object.entries(allCollections)
    .filter(([name, entries]) => !CURATED_COLLECTIONS.has(name) && entries.length > 0)
    .sort(([a], [b]) => a.localeCompare(b));

  // All facts for the panel
  const allFacts = getKBFacts(entity.id).filter(
    (f) => f.propertyId !== "description",
  );

  // Sort collections by date (most recent first)
  const sortedRounds = sortKBRecords(rawFundingRounds, "date", false);
  const sortedModels = sortKBRecords(modelReleases, "released", false);
  const sortedMilestones = sortKBRecords(safetyMilestones, "date", false);
  const sortedPartnerships = sortKBRecords(strategicPartnerships, "date", false);

  // Entity timeline events (PG entity_events, merged into factbase-data.json)
  const entityEvents: EntityEvent[] = getEntityEvents(entity.id);

  // Sort key persons: current first, then by start date descending
  const sortedPersons = [...keyPersons].sort((a, b) => {
    const endA = a.fields.end ? 1 : 0;
    const endB = b.fields.end ? 1 : 0;
    if (endA !== endB) return endA - endB;
    const startA = a.fields.start ? String(a.fields.start) : "";
    const startB = b.fields.start ? String(b.fields.start) : "";
    return startB.localeCompare(startA);
  });

  const wikiHref = entity.wikiId
    ? `/wiki/${entity.wikiId}`
    : entity.wikiPageId
      ? `/wiki/${entity.wikiPageId}`
      : null;

  // Fact sidebar data
  const latestByProp = getLatestFactsByProperty(allFacts);
  const categoryGroups = groupByCategory([...latestByProp.keys()]);

  // Description and website come from typed entity YAML data
  const descriptionText = orgData?.description ?? null;
  const websiteUrl = orgData?.website ?? null;

  // AI models developed by this org
  const orgModels = getTypedEntities()
    .filter(isAiModel)
    .filter((m) => m.developer === slug && m.releaseDate)
    .sort((a, b) => (b.releaseDate ?? "").localeCompare(a.releaseDate ?? ""))
    .map((m) => ({
      id: m.id,
      title: m.title,
      entityType: m.entityType,
      wikiId: m.wikiId,
      releaseDate: m.releaseDate ?? null,
      inputPrice: m.inputPrice ?? null,
      outputPrice: m.outputPrice ?? null,
      contextWindow: m.contextWindow ?? null,
      safetyLevel: m.safetyLevel ?? null,
      benchmarks: m.benchmarks?.length ? m.benchmarks : null,
    }));

  // Headquarters text
  const hqText =
    hqFact?.value.type === "text" ? hqFact.value.value : null;

  // ── Grants Made (this org is the funder) ──
  const grantRecords = getKBRecords(entity.id, "grants");
  const grantsMade = grantRecords
    .map(parseGrantRecord)
    .sort((a, b) => numericValue(b.amount) - numericValue(a.amount));

  // ── Funding Received (this org is a recipient in other orgs' grants) ──
  const allGrantRecords = getAllKBRecords("grants");
  const recipientMatchNames = new Set<string>([
    entity.name.toLowerCase(),
    slug.toLowerCase(),
    entity.id.toLowerCase(),
    ...(entity.aliases?.map((a) => a.toLowerCase()) ?? []),
  ]);
  // Also match by stableId — imported grants store the entity stableId as the
  // recipient field, not the slug or display name. Without this, orgs like MIRI
  // show 0 grants received despite having matched grants in the import pipeline.
  const kbStableId = resolveKBSlug(slug);
  if (kbStableId) recipientMatchNames.add(kbStableId.toLowerCase());
  if (typedEntity?.stableId) recipientMatchNames.add(typedEntity.stableId.toLowerCase());
  const grantsReceived: ReceivedGrant[] = allGrantRecords
    .filter((r) => {
      const recipientRaw = r.fields.recipient as string | undefined;
      if (!recipientRaw) return false;
      return recipientMatchNames.has(recipientRaw.toLowerCase());
    })
    .map((r) => {
      const parsed = parseGrantRecord(r);
      const funderEntity = getTypedEntityById(r.ownerEntityId);
      const funderSlug = funderEntity?.id ?? null;
      return {
        ...parsed,
        funderName: funderEntity?.title ?? r.ownerEntityId,
        funderHref: funderSlug ? `/organizations/${funderSlug}` : null,
        funderSlug: funderSlug ?? null,
      };
    })
    .sort((a, b) => numericValue(b.amount) - numericValue(a.amount));

  // ── Divisions (org subdivisions) ──
  const divisionRecords = getKBRecords(entity.id, "divisions");
  // Deduplicate divisions by name — merge fields from all copies so that
  // metadata (lead, website) and program connections (via key) are both preserved.
  const divisionsByName = new Map<string, ReturnType<typeof parseDivisionRecord>>();
  const divisionAltKeys = new Map<string, Set<string>>(); // name → all keys for this division
  for (const r of divisionRecords) {
    const parsed = parseDivisionRecord(r);
    const existing = divisionsByName.get(parsed.name);
    if (!existing) {
      divisionsByName.set(parsed.name, parsed);
      divisionAltKeys.set(parsed.name, new Set([parsed.key]));
    } else {
      // Merge: fill in any null fields from the new copy
      divisionAltKeys.get(parsed.name)!.add(parsed.key);
      for (const field of ["lead", "status", "startDate", "endDate", "slug", "website", "source", "notes", "description"] as const) {
        if (!existing[field] && parsed[field]) {
          (existing as Record<string, unknown>)[field] = parsed[field];
        }
      }
    }
  }
  const divisions = [...divisionsByName.values()]
    .map((parsed) => {
      // Resolve lead slug/stableId to human-readable name
      if (parsed.lead) {
        // Try TableBase entity resolution (handles slugs, E-numbers, and stableIds)
        const leadEntity = getTypedEntityById(parsed.lead);
        parsed.lead = leadEntity?.title ?? titleCase(parsed.lead.replace(/-/g, " "));
      }
      return parsed;
    })
    .sort((a, b) => a.name.localeCompare(b.name));

  // ── Dilution Stages ──
  const dilutionStageRecords = getKBRecords(entity.id, "dilution-stages");
  const dilutionStages = dilutionStageRecords
    .map(parseDilutionStageRecord)
    .sort((a, b) => (a.date ?? "").localeCompare(b.date ?? ""));

  // ── Funding Programs (RFPs, grant rounds, fellowships, etc.) ──
  const fundingProgramRecords = getKBRecords(entity.id, "funding-programs");
  const fundingPrograms = fundingProgramRecords
    .map(parseFundingProgramRecord)
    .sort((a, b) => (b.totalBudget ?? 0) - (a.totalBudget ?? 0));

  // ── Key Personnel (key-person, board, career records owned by this org) ──
  const personnelRecords = getKBRecords(entity.id, "personnel");
  const personnel: ParsedPersonnelRecord[] = personnelRecords
    .map((r) => {
      const parsed = parsePersonnelRecord(r);
      const resolved = parsed.personId
        ? resolveEntityName(parsed.personId, r.displayName)
        : { name: titleCase(r.key.replace(/-/g, " ")), href: null };
      return {
        ...parsed,
        personName: resolved.name,
        personHref: resolved.href,
      };
    })
    .sort((a, b) => {
      if (a.isFounder !== b.isFounder) return a.isFounder ? -1 : 1;
      const typeOrder: Record<string, number> = { "key-person": 0, board: 1, career: 2 };
      const aOrder = typeOrder[a.roleType] ?? 3;
      const bOrder = typeOrder[b.roleType] ?? 3;
      if (aOrder !== bOrder) return aOrder - bOrder;
      return a.personName.localeCompare(b.personName);
    });

  // ── Funding Rounds ──
  const fundingRoundRecords = getKBRecords(entity.id, "funding-rounds");
  const fundingRounds: ParsedFundingRoundRecord[] = fundingRoundRecords
    .map((r) => {
      const parsed = parseFundingRoundRecord(r);
      const resolved = parsed.leadInvestor
        ? resolveEntityName(parsed.leadInvestor, r.displayName)
        : { name: "", href: null };
      return {
        ...parsed,
        leadInvestorName: resolved.name || titleCase(parsed.leadInvestor ?? "") || "Unknown Investor",
        leadInvestorHref: resolved.href,
      };
    })
    .sort((a, b) => {
      if (a.date && b.date) return b.date.localeCompare(a.date);
      if (a.date) return -1;
      if (b.date) return 1;
      return (b.raised ?? 0) - (a.raised ?? 0);
    });

  // ── Investments Received ──
  const investmentRecords = getKBRecords(entity.id, "investments");
  const investmentsReceived: ParsedInvestmentRecord[] = investmentRecords
    .map((r) => {
      const parsed = parseInvestmentRecord(r);
      const resolved = parsed.investorId
        ? resolveEntityName(parsed.investorId, r.displayName)
        : { name: "", href: null };
      return {
        ...parsed,
        investorName: resolved.name || titleCase(parsed.investorId ?? "") || "Unknown Investor",
        investorHref: resolved.href,
      };
    })
    .sort((a, b) => numericValue(b.amount) - numericValue(a.amount));

  // ── Equity Positions ──
  const equityPositionRecords = getKBRecords(entity.id, "equity-positions");
  const equityPositions: ParsedEquityPositionRecord[] = equityPositionRecords
    .map((r) => {
      const parsed = parseEquityPositionRecord(r);
      const resolved = parsed.holderId
        ? resolveEntityName(parsed.holderId, r.displayName)
        : { name: "", href: null };
      return {
        ...parsed,
        holderName: resolved.name || "Unknown Holder",
        holderHref: resolved.href,
      };
    })
    .sort((a, b) => numericValue(b.stake) - numericValue(a.stake));

  // ── Charitable Pledges ──
  const pledgeRecords = getKBRecords(entity.id, "charitable-pledges");
  const charitablePledges = pledgeRecords.map((r) => parseCharitablePledgeRecord(r));

  // ── Board of Directors ──
  const boardSeatRecords = allCollections["board-seats"] ?? [];
  const boardMembers: BoardMember[] = boardSeatRecords
    .map((r) => {
      const parsed = parseBoardSeatRecord(r);
      const resolved = parsed.personId
        ? resolveEntityName(parsed.personId, r.displayName)
        : { name: titleCase(r.key.replace(/-/g, " ")), href: null };
      return {
        ...parsed,
        personName: resolved.name,
        personHref: resolved.href,
      };
    })
    .sort((a, b) => {
      const endA = a.departed ? 1 : 0;
      const endB = b.departed ? 1 : 0;
      if (endA !== endB) return endA - endB;
      const sa = a.appointed ?? "";
      const sb = b.appointed ?? "";
      return sb.localeCompare(sa);
    });

  // ── Related Organizations ──
  const relatedOrgs: RelatedOrg[] = [];
  const seenOrgIds = new Set<string>();

  // From strategic partnerships
  for (const sp of strategicPartnerships) {
    const partnerRef = sp.fields.partner != null ? String(sp.fields.partner) : undefined;
    if (!partnerRef) continue;
    const partnerEntityId = resolveKBSlug(partnerRef);
    const partnerEntity = partnerEntityId ? getTypedEntityById(partnerEntityId) : null;
    if (partnerEntity && partnerEntity.entityType === "organization" && partnerEntity.id !== entity.id && !seenOrgIds.has(partnerEntity.id)) {
      seenOrgIds.add(partnerEntity.id);
      relatedOrgs.push({
        id: partnerEntity.id,
        name: partnerEntity.title,
        slug: partnerEntity.id,
        relationship: sp.fields.type != null ? String(sp.fields.type) : "Partner",
        date: sp.fields.date != null ? String(sp.fields.date) : null,
      });
    }
  }

  // From grants made — unique recipient orgs (excluding self)
  for (const g of grantsMade) {
    if (!g.recipient) continue;
    const recipEntity = getTypedEntityById(g.recipient);
    if (recipEntity && recipEntity.entityType === "organization" && recipEntity.id !== entity.id && !seenOrgIds.has(recipEntity.id)) {
      seenOrgIds.add(recipEntity.id);
      relatedOrgs.push({
        id: recipEntity.id,
        name: recipEntity.title,
        slug: recipEntity.id,
        relationship: "Grantee",
        date: g.date,
      });
    }
  }

  // From grants received — unique funder orgs (excluding self)
  for (const g of grantsReceived) {
    if (!g.funderHref) continue;
    const funderOrgSlug = g.funderHref.replace("/organizations/", "");
    const funderOrgEntityId = resolveKBSlug(funderOrgSlug);
    if (funderOrgEntityId && funderOrgEntityId !== entity.id && !seenOrgIds.has(funderOrgEntityId)) {
      seenOrgIds.add(funderOrgEntityId);
      relatedOrgs.push({
        id: funderOrgEntityId,
        name: g.funderName,
        slug: funderOrgSlug,
        relationship: "Funder",
        date: g.date,
      });
    }
  }

  // ── Founded date + org age ──
  const foundedDateFact = getKBLatest(entity.id, "founded-date");
  const foundedDateStr = foundedDateFact?.value.type === "text" || foundedDateFact?.value.type === "date"
    ? foundedDateFact.value.value
    : foundedDateFact?.value.type === "number"
      ? String(foundedDateFact.value.value)
      : undefined;
  const orgAge = computeOrgAge(foundedDateStr);

  // ── Founded by ──
  const foundedByFact = getKBLatest(entity.id, "founded-by");
  const founders: Array<{ name: string; href: string | null }> = [];
  if (foundedByFact?.value.type === "refs" && Array.isArray(foundedByFact.value.value)) {
    for (const ref of foundedByFact.value.value) {
      const refStr = String(ref);
      const resolved = resolveEntityName(refStr);
      founders.push(resolved);
    }
  } else if (foundedByFact?.value.type === "ref") {
    const resolved = resolveEntityName(foundedByFact.value.value);
    founders.push(resolved);
  }

  // ── Resources (from entity_resources join table) ──
  const {
    publications: resourcePublications,
    announcements: resourceAnnouncements,
    aboutOrg: resourcesAboutOrg,
  } = getOrgResources(entity.name, typedEntity?.stableId);

  // ── Model benchmark data ──
  const modelBenchmarks = new Map<string, Array<{ name: string; score: number; unit?: string }>>();
  for (const model of orgModels) {
    if (model.benchmarks && model.benchmarks.length > 0) {
      modelBenchmarks.set(model.id, model.benchmarks);
    }
  }

  // ── Division lead resolution ──
  const divisionLeadResolved = new Map<string, { name: string; href: string | null }>();
  for (const d of divisions) {
    if (d.lead) {
      // Try TableBase directly (handles slugs, stableIds, E-numbers)
      const leadEntity = getTypedEntityById(d.lead);
      if (leadEntity) {
        const slug = leadEntity.id;
        divisionLeadResolved.set(d.key, {
          name: leadEntity.title,
          href: leadEntity.entityType === "person" ? `/people/${slug}` : (leadEntity.wikiId ? `/wiki/${leadEntity.wikiId}` : null),
        });
      } else {
        divisionLeadResolved.set(d.key, { name: d.lead, href: null });
      }
    }
  }

  // ── Division key members (match personnel to divisions by title keywords) ──
  const divisionMembers = new Map<string, Array<{ name: string; href: string | null; role: string | null }>>();
  for (const d of divisions) {
    const members: Array<{ name: string; href: string | null; role: string | null }> = [];
    const divNameLower = d.name.toLowerCase();
    // Build matching keywords from division name/key
    const divKeyLower = d.key.toLowerCase().replace(/-/g, " ");
    for (const p of personnel) {
      // Skip the lead — they're already shown separately
      const resolvedLeadSlug = d.lead?.toLowerCase();
      if (resolvedLeadSlug && p.personId?.toLowerCase() === resolvedLeadSlug) continue;
      if (!p.role) continue;
      // Skip people who have ended their tenure
      if (p.endDate) continue;
      const roleLower = p.role.toLowerCase();
      // Match if role mentions the division name or key
      if (roleLower.includes(divNameLower) || roleLower.includes(divKeyLower)) {
        members.push({ name: p.personName, href: p.personHref, role: p.role });
      }
    }
    if (members.length > 0) {
      divisionMembers.set(d.key, members);
    }
  }

  // ── Division spending stats ──
  // Compute total grant spending per division via: division → funding programs → grants.
  // Uses ALL alternate keys (from merged duplicates) to match funding programs.
  const divisionSpending = new Map<string, { totalAmount: number; grantCount: number }>();
  for (const d of divisions) {
    // All keys for this division (including duplicates that were merged)
    const allKeys = divisionAltKeys.get(d.name) ?? new Set([d.key]);

    // Find programs linked to ANY of this division's keys
    const divPrograms = fundingPrograms.filter((p) => {
      const raw = fundingProgramRecords.find((r) => r.key === p.key);
      if (!raw) return false;
      const divId = raw.fields.divisionId as string;
      return allKeys.has(divId);
    });
    const programKeys = new Set(divPrograms.map((p) => p.key));

    // Find grants matching those programs (or direct division name/key match)
    let totalAmount = 0;
    let grantCount = 0;
    const allKeysLower = new Set([...allKeys].map((k) => k.toLowerCase()));
    for (const g of grantRecords) {
      const programId = g.fields.programId as string | undefined;
      const gDiv = g.fields.divisionName as string | undefined;
      const gProgram = g.fields.program as string | undefined;
      const divName = d.name.toLowerCase();

      const matches =
        (programId && programKeys.has(programId)) ||
        (gDiv && (gDiv.toLowerCase() === divName || allKeysLower.has(gDiv.toLowerCase()))) ||
        (gProgram && allKeysLower.has(gProgram.toLowerCase()));

      if (matches) {
        const amount = typeof g.fields.amount === "number" ? g.fields.amount : 0;
        totalAmount += amount;
        grantCount++;
      }
    }
    if (grantCount > 0) {
      divisionSpending.set(d.key, { totalAmount, grantCount });
    }
  }

  // ── Computed stat cards ──
  const currentKeyPeople = sortedPersons.filter((p) => !p.fields.end).length;
  const currentBoardMembers = boardMembers.filter((m) => !m.departed).length;
  const totalGrantsMade = grantsMade.reduce((sum, g) => sum + numericValue(g.amount), 0);
  const totalGrantsReceived = grantsReceived.reduce((sum, g) => sum + numericValue(g.amount), 0);

  // ── Chart data: time series from KB facts ──
  const chartData = buildChartData(entity.id, sortedRounds, equityPositions);

  return {
    orgType,
    orgStatus,
    hqText,
    allCollections,
    otherCollections,
    allFacts,
    sortedRounds,
    sortedModels,
    sortedMilestones,
    entityEvents,
    sortedPartnerships,
    sortedPersons,
    wikiHref,
    latestByProp,
    categoryGroups,
    descriptionText,
    websiteUrl,
    orgModels,
    grantsMade,
    grantsReceived,
    divisions,
    fundingPrograms,
    personnel,
    fundingRounds,
    investmentsReceived,
    equityPositions,
    charitablePledges,
    boardMembers,
    relatedOrgs,
    foundedDateStr,
    orgAge,
    founders,
    currentKeyPeople,
    currentBoardMembers,
    totalGrantsMade,
    totalGrantsReceived,
    investments,
    products,
    resourcePublications,
    resourceAnnouncements,
    resourcesAboutOrg,
    modelBenchmarks,
    divisionLeadResolved,
    divisionMembers,
    divisionSpending,
    chartData,
    dilutionStages,
  };
}

// ── Lightweight header loader ────────────────────────────────────────

/**
 * Load only the data needed for the org profile header.
 * Much cheaper than loadOrgPageData — skips grants, resources, divisions, etc.
 */
export function loadOrgHeaderData(entity: OrgEntity, slug: string): OrgHeaderData {
  const typedEntity = getTypedEntityById(slug);
  const orgData = typedEntity && isOrganization(typedEntity) ? typedEntity : null;

  const hqFact = getKBLatest(entity.id, "headquarters");
  const hqText = hqFact?.value.type === "text" ? hqFact.value.value : null;

  const wikiHref = entity.wikiId
    ? `/wiki/${entity.wikiId}`
    : entity.wikiPageId
      ? `/wiki/${entity.wikiPageId}`
      : null;

  const foundedDateFact = getKBLatest(entity.id, "founded-date");
  const foundedDateStr = foundedDateFact?.value.type === "text" || foundedDateFact?.value.type === "date"
    ? foundedDateFact.value.value
    : foundedDateFact?.value.type === "number"
      ? String(foundedDateFact.value.value)
      : undefined;
  const orgAge = computeOrgAge(foundedDateStr);

  const foundedByFact = getKBLatest(entity.id, "founded-by");
  const founders: AuthorRef[] = [];
  if (foundedByFact?.value.type === "refs" && Array.isArray(foundedByFact.value.value)) {
    for (const ref of foundedByFact.value.value) {
      founders.push(resolveEntityName(String(ref)));
    }
  } else if (foundedByFact?.value.type === "ref") {
    founders.push(resolveEntityName(foundedByFact.value.value));
  }

  return {
    id: entity.id,
    name: entity.name,
    aliases: entity.aliases,
    orgType: orgData?.orgType ?? null,
    orgStatus: orgData?.orgStatus ?? null,
    foundedDateStr: foundedDateStr ?? null,
    orgAge: orgAge ?? null,
    hqText,
    websiteUrl: orgData?.website ?? null,
    wikiHref,
    founders,
    // entity has no sourcing verdicts yet; needs server-side roll-up (QUA-136)
    verdict: null,
  };
}
