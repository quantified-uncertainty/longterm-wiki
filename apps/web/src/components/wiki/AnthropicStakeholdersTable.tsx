/**
 * AnthropicStakeholdersTable -- STUB (records infrastructure removed).
 *
 * This component previously used KB record collections (equity-positions,
 * investments, charitable-pledges) which have been removed. It is kept as a
 * no-op stub so existing MDX pages that reference it don't break at build time.
 */

export async function AnthropicStakeholdersTable() {
  return (
    <div className="rounded-lg border p-4 text-sm text-muted-foreground">
      Stakeholder data is temporarily unavailable while records migrate to PostgreSQL.
    </div>
  );
}

export default AnthropicStakeholdersTable;
