/**
 * Barrel re-export for organization profile data.
 *
 * The implementation is split per-record-type under ./_data/. The underscore
 * prefix keeps Next.js from treating that directory as a route segment.
 * This file remains the public surface so external callers (page.tsx,
 * resources components, legislation/investments/funding-rounds pages, etc.)
 * keep their existing import paths.
 */
export * from "./_data/common";
export * from "./_data/entity";
export * from "./_data/grants";
export * from "./_data/divisions";
export * from "./_data/funding-programs";
export * from "./_data/personnel";
export * from "./_data/funding-rounds";
export * from "./_data/investments";
export * from "./_data/equity-positions";
export * from "./_data/dilution-stages";
export * from "./_data/charitable-pledges";
export * from "./_data/related-orgs";
export * from "./_data/resources";
export * from "./_data/charts";
export * from "./_data/loaders";
