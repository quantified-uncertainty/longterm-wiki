"use client";

// Re-export the shared InsightsTableClient for the internal page.
// The actual table implementation lives in @/components/wiki/InsightsTableClient
// and is also used by the MDX <InsightsTable /> server component wrapper.
export { InsightsTableClient as InsightsTable } from "@/components/wiki/InsightsTableClient";
