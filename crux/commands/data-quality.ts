/**
 * Data Quality Command Handlers
 *
 * Capture and view data quality snapshots that track coverage and verification
 * metrics across all data bases.
 */

import type { CommandResult } from "../lib/cli.ts";
import {
  captureSnapshot,
  getSnapshotHistory,
  getLatestSnapshot,
  type DataQualitySnapshot,
} from "../lib/wiki-server/data-quality.ts";

function formatPercent(part: number, total: number): string {
  if (total === 0) return "N/A";
  return `${((part / total) * 100).toFixed(1)}%`;
}

function formatSnapshot(s: DataQualitySnapshot): string {
  const lines: string[] = [];
  lines.push(`Snapshot #${s.id} — ${new Date(s.capturedAt).toLocaleString()}`);
  lines.push("");
  lines.push("Source-Check Verdicts:");
  lines.push(`  Total:         ${s.verdictsTotal}`);
  lines.push(`  Confirmed:     ${s.verdictsConfirmed}  (${formatPercent(s.verdictsConfirmed, s.verdictsTotal)})`);
  lines.push(`  Contradicted:  ${s.verdictsContradicted}  (${formatPercent(s.verdictsContradicted, s.verdictsTotal)})`);
  lines.push(`  Partial:       ${s.verdictsPartial}  (${formatPercent(s.verdictsPartial, s.verdictsTotal)})`);
  lines.push(`  Unverifiable:  ${s.verdictsUnverifiable}  (${formatPercent(s.verdictsUnverifiable, s.verdictsTotal)})`);
  lines.push(`  Outdated:      ${s.verdictsOutdated}  (${formatPercent(s.verdictsOutdated, s.verdictsTotal)})`);
  lines.push(`  Needs recheck: ${s.verdictsNeedsRecheck}`);
  lines.push("");
  lines.push("Record Coverage:");
  lines.push(`  Personnel:     ${s.personnelTotal} total, ${s.personnelWithSource} with source (${formatPercent(s.personnelWithSource, s.personnelTotal)}), ${s.personnelWithStartDate} with start date (${formatPercent(s.personnelWithStartDate, s.personnelTotal)})`);
  lines.push(`  Grants:        ${s.grantsTotal} total, ${s.grantsWithSource} with source (${formatPercent(s.grantsWithSource, s.grantsTotal)})`);
  lines.push(`  Investments:   ${s.investmentsTotal} total, ${s.investmentsWithSource} with source (${formatPercent(s.investmentsWithSource, s.investmentsTotal)})`);
  lines.push(`  Funding rnds:  ${s.fundingRoundsTotal} total`);
  lines.push("");
  lines.push("Entity & Page Coverage:");
  lines.push(`  Entities:      ${s.entitiesTotal} total, ${s.entitiesWithWikiPage} with wiki page (${formatPercent(s.entitiesWithWikiPage, s.entitiesTotal)})`);
  lines.push(`  Pages:         ${s.pagesTotal} total`);
  lines.push("");
  lines.push("FactBase:");
  lines.push(`  Entities:      ${s.factbaseEntities}`);
  lines.push(`  Facts:         ${s.factbaseFacts}`);
  return lines.join("\n");
}

export const commands: Record<
  string,
  (args: string[], options: Record<string, unknown>) => Promise<CommandResult>
> = {
  async snapshot(_args, options) {
    const json = !!options.json;
    console.log("Capturing data quality snapshot...");
    const result = await captureSnapshot();
    if (!result.ok) {
      const msg = `Failed to capture snapshot: ${result.message}`;
      if (json) return { output: JSON.stringify({ error: msg }), exitCode: 1 };
      console.error(msg);
      return { output: "", exitCode: 1 };
    }
    if (json) {
      return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
    }
    console.log(formatSnapshot(result.data.snapshot));
    return { output: "", exitCode: 0 };
  },

  async history(_args, options) {
    const json = !!options.json;
    const limit = options.limit ? parseInt(String(options.limit), 10) : 10;

    const result = await getSnapshotHistory({ limit });
    if (!result.ok) {
      const msg = `Failed to fetch history: ${result.message}`;
      if (json) return { output: JSON.stringify({ error: msg }), exitCode: 1 };
      console.error(msg);
      return { output: "", exitCode: 1 };
    }

    if (json) {
      return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
    }

    const { snapshots, total } = result.data;
    console.log(`Data Quality Snapshots (${snapshots.length} of ${total}):\n`);

    if (snapshots.length === 0) {
      console.log("No snapshots yet. Run `crux sys quality snapshot` to capture one.");
      return { output: "", exitCode: 0 };
    }

    // Summary table
    console.log(
      "ID   | Captured At          | Verdicts | Personnel | Grants | Entities | Pages"
    );
    console.log(
      "---- | -------------------- | -------- | --------- | ------ | -------- | -----"
    );
    for (const s of snapshots) {
      const date = new Date(s.capturedAt).toISOString().slice(0, 19).replace("T", " ");
      console.log(
        `${String(s.id).padStart(4)} | ${date} | ${String(s.verdictsTotal).padStart(8)} | ${String(s.personnelTotal).padStart(9)} | ${String(s.grantsTotal).padStart(6)} | ${String(s.entitiesTotal).padStart(8)} | ${String(s.pagesTotal).padStart(5)}`
      );
    }

    return { output: "", exitCode: 0 };
  },

  async latest(_args, options) {
    const json = !!options.json;

    const result = await getLatestSnapshot();
    if (!result.ok) {
      const msg = `Failed to fetch latest snapshot: ${result.message}`;
      if (json) return { output: JSON.stringify({ error: msg }), exitCode: 1 };
      console.error(msg);
      return { output: "", exitCode: 1 };
    }

    if (json) {
      return { output: JSON.stringify(result.data, null, 2), exitCode: 0 };
    }

    if (!result.data.snapshot) {
      console.log("No snapshots yet. Run `crux sys quality snapshot` to capture one.");
      return { output: "", exitCode: 0 };
    }

    console.log(formatSnapshot(result.data.snapshot));
    return { output: "", exitCode: 0 };
  },

  default: undefined as unknown as (
    args: string[],
    options: Record<string, unknown>
  ) => Promise<CommandResult>,
};

// Wire default to `latest`
commands.default = commands.latest;

export function getHelp() {
  return `
Data Quality Domain — Track data coverage and verification metrics

Commands:
  snapshot        Capture a new data quality snapshot
  history         List recent snapshots (default: last 10)
  latest          Show the most recent snapshot (default command)

Options:
  --json          JSON output
  --limit=N       Number of history entries to show (default: 10)

Examples:
  crux sys quality snapshot           Capture a new snapshot
  crux sys quality history            Show recent snapshots
  crux sys quality latest             Show the latest snapshot
  crux sys quality --json             Latest snapshot as JSON
`;
}
