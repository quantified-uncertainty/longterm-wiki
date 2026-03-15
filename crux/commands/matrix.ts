/**
 * Matrix Command — Entity completeness matrix scanner and reporting
 */

import { buildCommands } from "../lib/cli.ts";

const SCRIPTS = {
  scan: {
    script: "entity-matrix/scan.ts",
    description: "Scan entity completeness and show matrix",
    passthrough: ["json", "brief"],
  },
  gaps: {
    script: "entity-matrix/gaps.ts",
    description: "Find highest-impact missing infrastructure",
    passthrough: ["json", "top", "group", "type"],
  },
};

export const commands = buildCommands(SCRIPTS, "scan");

export function getHelp() {
  const commandList = Object.entries(SCRIPTS)
    .map(([name, config]) => `  ${name.padEnd(14)} ${config.description}`)
    .join("\n");

  return `
Matrix Domain — Entity completeness tracking

Commands:
${commandList}

Options:
  --json          JSON output (full matrix snapshot)
  --brief         Summary scores only (scan)
  --top=N         Show top N gaps (gaps, default 20)
  --group=X       Filter by dimension group (gaps)
  --type=X        Filter by entity type (gaps)

Examples:
  crux matrix                     Full scan with details
  crux matrix scan --brief        Summary scores only
  crux matrix scan --json         Machine-readable output
  crux matrix gaps                Top 20 highest-impact gaps
  crux matrix gaps --top=10       Top 10 gaps
  crux matrix gaps --group=api    Only API-related gaps
  crux matrix gaps --type=person  Only gaps for person type
`;
}
