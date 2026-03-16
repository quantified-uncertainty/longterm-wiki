/**
 * WikiBase routes — long-form prose MDX articles, citations, references.
 *
 * Covers: pages, links, citations, resources, hallucination risk,
 * assessments, explore, edit logs, summaries, references.
 */
export { pagesRoute, SyncPageSchema, SyncBatchSchema, type PagesRoute } from "./pages.js";
export { linksRoute, type LinksRoute } from "./links.js";
export { citationsRoute, type CitationsRoute } from "./citations.js";
export { resourcesRoute, type ResourcesRoute } from "./resources.js";
export { hallucinationRiskRoute, clearMatViewCache, type HallucinationRiskRoute } from "./hallucination-risk.js";
export { assessmentsRoute, type AssessmentsRoute } from "./assessments.js";
export { exploreRoute, type ExploreRoute } from "./explore.js";
export { editLogsRoute, type EditLogsRoute } from "./edit-logs.js";
export { summariesRoute, type SummariesRoute } from "./summaries.js";
export { referencesRoute, type ReferencesRoute } from "./references.js";
