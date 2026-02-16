import { getInsights } from "@/data";
import { InsightsTableClient } from "./InsightsTableClient";

/**
 * Server component that loads insights data and renders the interactive table.
 * Used in MDX pages via <InsightsTable />.
 */
export function InsightsTable() {
  const insights = getInsights();
  return <InsightsTableClient data={insights} />;
}
