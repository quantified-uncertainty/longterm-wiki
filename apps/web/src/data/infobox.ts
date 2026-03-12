/**
 * Entity info box data helpers and child page lookups.
 */

import {
  getDatabase,
  getTypedEntities,
  getTypedEntityById,
  getPageById,
  isRisk,
  isPerson,
  isOrganization,
  isPolicy,
  isAiModel,
} from "./database";
import { getEntityHref } from "./entity-nav";

export interface ChildPageEntry {
  id: string;
  title: string;
  type: string;
  href: string;
}

/**
 * Find all entities that reference this overview page via `summaryPage`.
 * Returns them grouped by entity type for display in the InfoBox.
 */
export function getChildPagesForOverview(overviewId: string): ChildPageEntry[] {
  const allEntities = getTypedEntities();
  const children: ChildPageEntry[] = [];

  for (const entity of allEntities) {
    if (entity.summaryPage === overviewId) {
      children.push({
        id: entity.id,
        title: entity.title,
        type: entity.entityType,
        href: getEntityHref(entity.id, entity.entityType),
      });
    }
  }

  // Sort alphabetically by title
  children.sort((a, b) => a.title.localeCompare(b.title));
  return children;
}

export function getEntityInfoBoxData(entityId: string) {
  const entity = getTypedEntityById(entityId);
  if (!entity) return null;

  const resolvedRelatedEntries = entity.relatedEntries?.map((entry) => ({
    id: entry.id,
    type: entry.type,
    title:
      getTypedEntityById(entry.id)?.title ||
      entry.id
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" "),
    href: getEntityHref(entry.id, entry.type),
  }));

  // Resolve likelihood/timeframe to strings
  let likelihoodStr: string | undefined;
  let timeframeStr: string | undefined;
  let category: string | undefined;
  let maturity: string | undefined;
  let relatedSolutions: Array<{ id: string; title: string; type: string; href: string }> | undefined;
  let severity: string | undefined;

  if (isRisk(entity)) {
    severity = entity.severity;
    category = entity.riskCategory;
    maturity = entity.maturity;
    if (entity.likelihood) {
      likelihoodStr =
        typeof entity.likelihood === "string"
          ? entity.likelihood
          : entity.likelihood?.display || entity.likelihood?.level;
    }
    if (entity.timeframe) {
      timeframeStr =
        typeof entity.timeframe === "string"
          ? entity.timeframe
          : entity.timeframe?.display || String(entity.timeframe?.median || "");
    }
    // Find related solutions
    const allEntities = getTypedEntities();
    relatedSolutions = [];
    for (const solution of allEntities) {
      if (
        solution.entityType === "safety-agenda" ||
        solution.entityType === "approach" ||
        solution.entityType === "project"
      ) {
        const linkedRisks =
          solution.relatedEntries?.filter((re) => re.type === "risk") || [];
        if (linkedRisks.some((r) => r.id === entity.id)) {
          relatedSolutions.push({
            id: solution.id,
            title: solution.title,
            type: solution.entityType,
            href: getEntityHref(solution.id, solution.entityType),
          });
        }
      }
    }
  }

  // Person-specific fields
  let affiliation: string | undefined;
  let role: string | undefined;
  let knownFor: string | undefined;

  if (isPerson(entity)) {
    affiliation = entity.affiliation;
    role = entity.role;
    knownFor = entity.knownFor?.join(", ");
  }

  // Organization-specific fields
  let founded: string | undefined;
  let location: string | undefined;
  let headcount: string | undefined;
  let funding: string | undefined;
  let orgType: string | undefined;

  if (isOrganization(entity)) {
    founded = entity.founded;
    location = entity.headquarters;
    headcount = entity.employees;
    funding = entity.funding;
    orgType = entity.orgType;
  }

  // Policy-specific fields
  let introduced: string | undefined;
  let policyStatus: string | undefined;
  let policyAuthor: string | undefined;
  let scope: string | undefined;

  if (isPolicy(entity)) {
    introduced = entity.introduced;
    policyStatus = entity.policyStatus;
    policyAuthor = entity.author;
    scope = entity.scope;
  }

  // AI Model-specific fields
  let modelFamily: string | undefined;
  let modelTier: string | undefined;
  let releaseDate: string | undefined;
  let developer: string | undefined;
  let developerId: string | undefined;
  let inputPrice: number | undefined;
  let outputPrice: number | undefined;
  let contextWindow: number | undefined;
  let safetyLevel: string | undefined;
  let benchmarks: Array<{ name: string; score: number; unit?: string }> | undefined;
  let modality: string[] | undefined;
  let openWeight: boolean | undefined;
  let parameterCount: string | undefined;
  let trainingCutoff: string | undefined;

  if (isAiModel(entity)) {
    modelFamily = entity.modelFamily;
    modelTier = entity.modelTier;
    releaseDate = entity.releaseDate;
    // Resolve developer to display name, keeping ID for linking
    if (entity.developer) {
      developerId = entity.developer;
      const devEntity = getTypedEntityById(entity.developer);
      developer = devEntity?.title ?? entity.developer;
    }
    inputPrice = entity.inputPrice;
    outputPrice = entity.outputPrice;
    contextWindow = entity.contextWindow;
    safetyLevel = entity.safetyLevel;
    benchmarks = entity.benchmarks?.length ? entity.benchmarks : undefined;
    modality = entity.modality?.length ? entity.modality : undefined;
    openWeight = entity.openWeight;
    parameterCount = entity.parameterCount;
    trainingCutoff = entity.trainingCutoff;
  }

  // Resolve summaryPage to title + href
  let summaryPage: { title: string; href: string } | undefined;
  if (entity.summaryPage) {
    const summaryEntity = getTypedEntityById(entity.summaryPage);
    const summaryPageData = getPageById(entity.summaryPage);
    const summaryTitle =
      summaryEntity?.title ||
      summaryPageData?.title ||
      entity.summaryPage
        .split("-")
        .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(" ");
    summaryPage = {
      title: summaryTitle,
      href: getEntityHref(entity.summaryPage),
    };
  }

  return {
    type: entity.entityType,
    title: entity.title,
    severity,
    likelihood: likelihoodStr,
    timeframe: timeframeStr,
    website: entity.website,
    customFields: entity.customFields,
    relatedTopics: entity.relatedTopics,
    relatedEntries: resolvedRelatedEntries,
    category,
    maturity,
    relatedSolutions,
    summaryPage,
    // Person
    affiliation,
    role,
    knownFor,
    // Organization
    founded,
    location,
    headcount,
    funding,
    orgType,
    // Policy
    introduced,
    policyStatus,
    policyAuthor,
    scope,
    // AI Model
    modelTier,
    releaseDate,
    developer,
    developerId,
    inputPrice,
    outputPrice,
    contextWindow,
    safetyLevel,
    benchmarks,
    modality,
    openWeight,
    parameterCount,
    trainingCutoff,
    // Overview
    childPages: entity.entityType === "overview"
      ? getChildPagesForOverview(entity.id)
      : undefined,
  };
}
