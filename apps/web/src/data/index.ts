/**
 * Data layer for longterm-wiki — barrel re-export.
 *
 * All consumers should import from "@/data" (this file) for backward compatibility.
 * Implementation is split across domain modules:
 *  - database.ts        — core types, DB loading, entity/resource indexes, basic lookups
 *  - entity-nav.ts      — URL resolution, backlinks, related graph
 *  - page-rankings.ts   — update schedule, page rankings
 *  - page-changes.ts    — change history, sessions
 *  - page-coverage.ts   — coverage scores, citation health
 *  - hallucination-risk.ts — risk stats, citation quotes/dots
 *  - cruxes.ts          — crux lookups
 *  - infobox.ts         — entity infobox data
 *  - external-links.ts  — external links YAML
 *  - explore.ts         — explore/browse items
 */

export * from "./database";
export * from "./entity-nav";
export * from "./page-rankings";
export * from "./page-changes";
export * from "./page-coverage";
export * from "./hallucination-risk";
export * from "./cruxes";
export * from "./infobox";
export * from "./external-links";
export * from "./explore";
