#!/usr/bin/env -S node --import tsx/esm
// E4: call runResearch() directly to see what URLs the discovery primitive would have surfaced.
import { runResearch } from "../lib/search/research-agent.ts";

const result = await runResearch({
  topic: "FISA Section 702 RISAA reauthorization 2024",
  pageContext: { title: "FISA Section 702", type: "policy", entityId: "fisa-702" },
  config: {
    useExa: true,
    usePerplexity: true,
    useScry: false,
    useGitHub: false,
    useSemanticScholar: false,
    useFederalRegister: true,
    maxResultsPerSource: 8,
    maxUrlsToFetch: 15,
    extractFacts: false,
  },
  budgetCap: 1.0,
});

console.log(`\n=== runResearch results ===`);
console.log(`sources: ${result.sources.length}`);
console.log(`metadata:`, result.metadata);
for (const s of result.sources) {
  console.log(`  [${s.provider ?? "?"}] ${s.url}`);
  if (s.title) console.log(`    title: ${s.title.slice(0, 100)}`);
}
