/**
 * T1 importer command exports.
 *
 * Wires all T1 importer CLIs into the tb command tree:
 *
 *   QUA-640:
 *     - `crux tb sec-edgar           --target=slug:cik                       [--submit]`
 *     - `crux tb github-contributors --target=slug:owner/repo[,owner/repo2]  [--submit]`
 *     - `crux tb hf-leaderboard      --target=modelSlug:displayName:evalName [--submit]`
 *
 *   QUA-666:
 *     - `crux tb wikidata            --target=slug:Qnumber                   [--submit]`
 *     - `crux tb openalex            --target=slug:Iinstitution_id           [--submit]`
 *     - `crux tb semantic-scholar    --target=personSlug:displayName:authorId [--submit]`
 *     - `crux tb crossref            --target=doi:10.xxx/yyy[|org=slug][|person=slug] [--submit]`
 *
 * `--submit` is wired through to the propose-client; today the endpoint
 * (QUA-632) does not yet exist so submit-mode returns `pending`. Until then,
 * default behavior (dry-run) prints what would be sent.
 */

import { cliMain as secEdgarCliMain } from "./sec-edgar.ts";
import { cliMain as ghContribCliMain } from "./github-contributors.ts";
import { cliMain as hfLeaderboardCliMain } from "./hf-leaderboard.ts";
import { cliMain as wikidataCliMain } from "./wikidata.ts";
import { cliMain as openalexCliMain } from "./openalex.ts";
import { cliMain as semanticScholarCliMain } from "./semantic-scholar.ts";
import { cliMain as crossrefCliMain } from "./crossref.ts";

// The crux dispatcher passes (args, options); the importers ignore options
// (their flags are parsed from `args`), so a one-arg adapter is sufficient.
const adapt = (fn: (args: string[]) => unknown) => (args: string[]) => fn(args);

export const commands = {
  // QUA-640
  "sec-edgar": adapt(secEdgarCliMain),
  "github-contributors": adapt(ghContribCliMain),
  "hf-leaderboard": adapt(hfLeaderboardCliMain),
  // QUA-666
  "wikidata": adapt(wikidataCliMain),
  "openalex": adapt(openalexCliMain),
  "semantic-scholar": adapt(semanticScholarCliMain),
  "crossref": adapt(crossrefCliMain),
};

export function getHelp(): string {
  return `
T1 importers — defensive enrichment via authoritative sources (QUA-637)

Commands:
  sec-edgar              Fetch SEC EDGAR Form D filings → funding-rounds
  github-contributors    Fetch GitHub contributors API → personnel hints
  hf-leaderboard         Fetch HuggingFace Open LLM Leaderboard → benchmark-results
  wikidata               Fetch Wikidata SPARQL facts → organization-fact records
  openalex               Fetch OpenAlex works by institution → publications
  semantic-scholar       Fetch Semantic Scholar papers by author → publications
  crossref               Fetch Crossref DOI metadata → publications

Usage:
  crux tb sec-edgar --target=anthropic:1828101 [--submit]
  crux tb github-contributors --target=anthropic:anthropics/anthropic-sdk-python [--submit]
  crux tb hf-leaderboard --target=llama-3-70b:Llama-3-70B:meta-llama/Llama-3-70B [--submit]
  crux tb wikidata --target=anthropic:Q108542504 [--submit]
  crux tb openalex --target=anthropic:I4210125762 [--submit]
  crux tb semantic-scholar --target=dario-amodei:Dario Amodei:1712334 [--submit]
  crux tb crossref --target=doi:10.1145/3442188.3445922|org=anthropic [--submit]

All importers default to dry-run mode (print proposals, don't POST).
Pass --submit to attempt POST to /api/enrichment/propose (blocked on QUA-632).
`;
}
