/**
 * Upsert all source URLs from KB thing files to the wiki-server resources DB.
 * Run: WIKI_SERVER_ENV=prod npx tsx packages/kb/scripts/upsert-resources.ts
 */
import "dotenv/config";
import yaml from "yaml";
import { readFileSync, readdirSync } from "fs";
import { join } from "path";
import { createHash } from "crypto";
import { upsertResourceBatch } from "../../../crux/lib/wiki-server/resources.ts";

const KB_DATA_DIR = join(import.meta.dirname, "../data");

function urlToId(url: string): string {
  return createHash("sha256").update(url).digest("hex").slice(0, 16);
}

function guessType(
  url: string
): "paper" | "blog" | "web" | "report" | "reference" {
  if (url.includes("arxiv.org")) return "paper";
  if (
    url.includes("anthropic.com/research") ||
    url.includes("transformer-circuits.pub")
  )
    return "paper";
  if (
    url.includes("anthropic.com/news") ||
    url.includes("anthropic.com/index")
  )
    return "blog";
  return "web";
}

interface UpsertItem {
  id: string;
  url: string;
  type: "paper" | "blog" | "web" | "report" | "reference";
  tags: string[];
  citedBy: string[];
}

async function main() {
  const thingsDir = join(KB_DATA_DIR, "things");
  const files = readdirSync(thingsDir).filter((f) => f.endsWith(".yaml"));

  const allItems: UpsertItem[] = [];
  const seenUrls = new Set<string>();

  for (const file of files) {
    const data = yaml.parse(readFileSync(join(thingsDir, file), "utf8"));
    const entityId = data.thing?.id ?? file.replace(".yaml", "");

    // Collect URLs from facts
    for (const fact of data.facts ?? []) {
      if (fact.source && fact.source.startsWith("http") && !seenUrls.has(fact.source)) {
        seenUrls.add(fact.source);
        allItems.push({
          id: urlToId(fact.source),
          url: fact.source,
          type: guessType(fact.source),
          tags: [entityId, "kb-source"],
          citedBy: [entityId],
        });
      }
    }

    // Collect URLs from items
    for (const coll of Object.values(data.items ?? {})) {
      const entries = (coll as { entries?: Record<string, Record<string, unknown>> }).entries ?? {};
      for (const entry of Object.values(entries)) {
        for (const field of ["source", "key-publication"]) {
          const url = entry[field] as string | undefined;
          if (url && url.startsWith("http") && !seenUrls.has(url)) {
            seenUrls.add(url);
            allItems.push({
              id: urlToId(url),
              url,
              type: guessType(url),
              tags: [entityId, "kb-source"],
              citedBy: [entityId],
            });
          }
        }
      }
    }
  }

  console.log(`Found ${allItems.length} unique source URLs across ${files.length} entity files`);

  // Batch upsert in groups of 50
  const batchSize = 50;
  let totalUpserted = 0;

  for (let i = 0; i < allItems.length; i += batchSize) {
    const batch = allItems.slice(i, i + batchSize);
    const result = await upsertResourceBatch(batch);
    if (result.ok) {
      totalUpserted += result.data.upserted;
      console.log(
        `  Batch ${Math.floor(i / batchSize) + 1}: ${result.data.upserted} upserted`
      );
    } else {
      console.error(
        `  Batch ${Math.floor(i / batchSize) + 1} failed:`,
        result.error
      );
    }
  }

  console.log(`Done! Total upserted: ${totalUpserted}`);
}

main().catch(console.error);
