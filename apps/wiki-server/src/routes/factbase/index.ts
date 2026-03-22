/**
 * FactBase routes — structured triples with temporal data and provenance.
 *
 * Covers: facts CRUD, factbase source checks.
 */
export { factsRoute, type FactsRoute } from "./facts.js";
export { factbaseSourceChecksRoute, type FactbaseSourceChecksRoute } from "./factbase-source-checks.js";
// Deprecated aliases for backwards compat
export { factbaseVerificationsRoute, type FactbaseVerificationsRoute } from "./factbase-source-checks.js";
