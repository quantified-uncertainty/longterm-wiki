/**
 * AnthropicStakeholdersTable — server wrapper
 *
 * Reads live fact data (valuation) server-side and passes it to the
 * interactive client component. This split is required because getFact()
 * uses fs.readFileSync and can only run on the server.
 */

import { getFact } from "@/data";
import { AnthropicStakeholdersTableClient } from "./AnthropicStakeholdersTableClient";

export function AnthropicStakeholdersTable() {
  const valuationFact = getFact("anthropic", "6796e194");
  return (
    <AnthropicStakeholdersTableClient
      valuation={valuationFact?.numeric ?? 380e9}
      valuationDisplay={valuationFact?.value ?? "$380B"}
      asOf={valuationFact?.asOf}
    />
  );
}

export default AnthropicStakeholdersTable;
