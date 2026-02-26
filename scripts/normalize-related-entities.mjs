/**
 * Normalize relatedEntities values in the claims database.
 *
 * Reads all claims with relatedEntities, applies normalization map,
 * and batch-updates via the wiki-server API.
 *
 * Run:
 *   node scripts/normalize-related-entities.mjs           # dry run
 *   node scripts/normalize-related-entities.mjs --apply   # apply changes
 */
import { config } from "dotenv";
config({ path: ".env" });

const base = process.env.LONGTERMWIKI_SERVER_URL || "http://localhost:7778";
const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY;
const dryRun = !process.argv.includes("--apply");

const headers = { "Content-Type": "application/json" };
if (apiKey) headers["Authorization"] = `Bearer ${apiKey}`;

// Normalization map: unnormalized value -> canonical entity slug
// Only includes mappings where we're confident about the match.
const NORMALIZATION_MAP = {
  // Space-to-hyphen (trivial)
  "far ai": "far-ai",
  "redwood research": "redwood-research",
  "stuart russell": "stuart-russell",
  "paul christiano": "paul-christiano",
  "open philanthropy": "open-philanthropy",
  "coefficient giving": "coefficient-giving",
  "buck shlegeris": "buck-shlegeris",
  "yann lecun": "yann-lecun",
  "constitutional ai": "constitutional-ai",
  "robin hanson": "robin-hanson",
  "epoch ai": "epoch-ai",
  "dario amodei": "dario-amodei",
  "daniela amodei": "daniela-amodei",
  "eliezer yudkowsky": "eliezer-yudkowsky",
  "apollo research": "apollo-research",
  "nate soares": "nate-soares",
  "chris olah": "chris-olah",
  "yoshua bengio": "yoshua-bengio",

  // Dot/variant to hyphen
  "far.ai": "far-ai",
  "far.labs": "far-ai",

  // Aliases (confident matches)
  "nanda": "neel-nanda",
  "christiano": "paul-christiano",
  "redwood": "redwood-research",
  "machine intelligence research institute": "miri",
  "cotra": "ajeya-cotra",
  "google deepmind": "deepmind",
  "future of life institute": "fli",
  "future-of-life-institute": "fli",
  "russell": "stuart-russell",
  "manifold markets": "manifold",
  "metaculus aggregate": "metaculus",
  "kwa/metr": "metr",
  "open philanthropy project": "open-philanthropy",
  "survival and flourishing fund": "sff",
};

// --- Main ---

// 1. Fetch all claims with relatedEntities
console.log("Fetching claims with relatedEntities...");
let allClaims = [];
let offset = 0;
const limit = 200;
while (true) {
  const res = await fetch(
    `${base}/api/claims/all?limit=${limit}&offset=${offset}&multiEntity=true`,
    { headers }
  );
  const data = await res.json();
  const claims = data.claims || [];
  if (claims.length === 0) break;
  allClaims.push(...claims);
  offset += limit;
  if (claims.length < limit) break;
}
console.log(`Found ${allClaims.length} claims with relatedEntities\n`);

// 2. Build update batch
const updates = []; // { id, relatedEntities }
let totalNormalized = 0;
const normCounts = {};

for (const claim of allClaims) {
  if (!claim.relatedEntities || claim.relatedEntities.length === 0) continue;

  let changed = false;
  const newEntities = claim.relatedEntities.map((re) => {
    const normalized = NORMALIZATION_MAP[re];
    if (normalized && normalized !== re) {
      changed = true;
      totalNormalized++;
      normCounts[`"${re}" -> "${normalized}"`] =
        (normCounts[`"${re}" -> "${normalized}"`] || 0) + 1;
      return normalized;
    }
    return re;
  });

  if (changed) {
    // Deduplicate (e.g. if "redwood" and "redwood-research" both existed)
    const deduped = [...new Set(newEntities)];
    updates.push({ id: claim.id, relatedEntities: deduped });
  }
}

// 3. Report
console.log(`Claims to update: ${updates.length}`);
console.log(`Total values normalized: ${totalNormalized}`);
console.log("\nNormalization breakdown:");
const sortedCounts = Object.entries(normCounts).sort((a, b) => b[1] - a[1]);
for (const [mapping, count] of sortedCounts) {
  console.log(`  ${mapping}: ${count}`);
}

if (updates.length === 0) {
  console.log("\nNothing to update.");
  process.exit(0);
}

if (dryRun) {
  console.log("\n[DRY RUN] No changes applied. Run with --apply to update.");
  console.log("\nSample updates:");
  for (const u of updates.slice(0, 5)) {
    const original = allClaims.find((c) => c.id === u.id);
    console.log(`  Claim #${u.id}:`);
    console.log(`    Before: ${JSON.stringify(original.relatedEntities)}`);
    console.log(`    After:  ${JSON.stringify(u.relatedEntities)}`);
  }
  process.exit(0);
}

// 4. Batch update
console.log("\nApplying updates...");
const batchSize = 200;
let totalUpdated = 0;
for (let i = 0; i < updates.length; i += batchSize) {
  const batch = updates.slice(i, i + batchSize);
  const res = await fetch(`${base}/api/claims/batch-update-related-entities`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ items: batch }),
  });
  const result = await res.json();
  if (result.updated) {
    totalUpdated += result.updated;
    console.log(
      `  Batch ${Math.floor(i / batchSize) + 1}: updated ${result.updated}/${batch.length}`
    );
  } else {
    console.error(`  Batch ${Math.floor(i / batchSize) + 1} error:`, result);
  }
}

console.log(`\nDone. Updated ${totalUpdated} claims.`);
