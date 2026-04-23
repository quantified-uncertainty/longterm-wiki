/**
 * T1 importer command exports (QUA-640).
 *
 * Wires the three importer CLIs into the tb command tree:
 *   - `crux tb sec-edgar           --target=slug:cik [--submit]`
 *   - `crux tb github-contributors --target=slug:owner/repo[,owner/repo2] [--submit]`
 *   - `crux tb hf-leaderboard      --target=modelSlug:displayName:evalName [--submit]`
 *
 * `--submit` is wired through to the propose-client; today the endpoint
 * (QUA-632) does not yet exist so submit-mode returns `pending`. Until then,
 * default behavior (dry-run) prints what would be sent.
 */

import { cliMain as secEdgarCliMain } from "./sec-edgar.ts";
import { cliMain as ghContribCliMain } from "./github-contributors.ts";
import { cliMain as hfLeaderboardCliMain } from "./hf-leaderboard.ts";

// The crux dispatcher passes (args, options); the importers ignore options
// (their flags are parsed from `args`), so a one-arg adapter is sufficient.
const adapt = (fn: (args: string[]) => unknown) => (args: string[]) => fn(args);

export const commands = {
  "sec-edgar": adapt(secEdgarCliMain),
  "github-contributors": adapt(ghContribCliMain),
  "hf-leaderboard": adapt(hfLeaderboardCliMain),
};

export function getHelp(): string {
  return `
T1 importers — defensive enrichment via authoritative sources (QUA-640)

Commands:
  sec-edgar              Fetch SEC EDGAR Form D filings → funding-rounds
  github-contributors    Fetch GitHub contributors API → personnel hints
  hf-leaderboard         Fetch HuggingFace Open LLM Leaderboard → benchmark-results

Usage:
  crux tb sec-edgar --target=anthropic:1828101 [--submit]
  crux tb github-contributors --target=anthropic:anthropics/anthropic-sdk-python [--submit]
  crux tb hf-leaderboard --target=llama-3-70b:Llama-3-70B:meta-llama/Llama-3-70B [--submit]

All importers default to dry-run mode (print proposals, don't POST).
Pass --submit to attempt POST to /api/enrichment/propose (blocked on QUA-632).
`;
}
