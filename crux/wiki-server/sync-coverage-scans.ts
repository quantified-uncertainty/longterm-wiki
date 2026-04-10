/**
 * Coverage Scan Sync — computes entity coverage scores and syncs to wiki-server.
 * Usage: pnpm crux wiki-server sync-coverage-scans [--dry-run] [--batch-size=N]
 */
import { readFileSync } from "fs";
import { join } from "path";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { batchSync, waitForHealthy } from "./sync-common.ts";
import {
  computeOrgCoverage, computePersonCoverage, computeAiModelCoverage,
  computeLegislationCoverage, computeProjectCoverage, computeBenchmarkCoverage,
  computeGenericCoverage, type OrgCoverageInput, type PersonCoverageInput,
} from "../../apps/web/src/components/coverage/coverage-score.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const DATABASE_JSON = join(PROJECT_ROOT, "apps/web/src/data/database.json");
const FACTBASE_JSON = join(PROJECT_ROOT, "apps/web/src/data/factbase-data.json");

interface TypedEntity { id: string; stableId?: string; title: string; entityType: string; description?: string; tags?: string[]; wikiId?: string; clusters?: string[]; [key: string]: unknown; }
interface FactValue { type: string; value: unknown; }
interface Fact { propertyId: string; value: FactValue; asOf?: string; }
interface CoverageScanItem { entityType: string; entityId: string; coverageScore: number; signalsFilled: number; signalsTotal: number; signals: Record<string, boolean>; scannedAt: string; }

function loadFactBase(): Map<string, Fact[]> {
  try {
    const raw = JSON.parse(readFileSync(FACTBASE_JSON, "utf-8"));
    const map = new Map<string, Fact[]>();
    if (raw.facts) for (const [id, facts] of Object.entries(raw.facts)) map.set(id, facts as Fact[]);
    return map;
  } catch { console.warn("  Warning: Could not load factbase-data.json"); return new Map(); }
}

function getLatestFact(facts: Map<string, Fact[]>, entityId: string, prop: string): Fact | null {
  const ef = facts.get(entityId); if (!ef) return null;
  const m = ef.filter((f) => f.propertyId === prop); if (!m.length) return null;
  m.sort((a, b) => (b.asOf ?? "").localeCompare(a.asOf ?? "")); return m[0];
}
function kbNum(facts: Map<string, Fact[]>, id: string, p: string): number | null { const f = getLatestFact(facts, id, p); return f?.value.type === "number" ? f.value.value as number : null; }
function kbText(facts: Map<string, Fact[]>, id: string, p: string): string | null { const f = getLatestFact(facts, id, p); return (f?.value.type === "text" || f?.value.type === "date") ? f.value.value as string : null; }
function kbRef(facts: Map<string, Fact[]>, id: string, p: string): string | null { const f = getLatestFact(facts, id, p); return f?.value.type === "ref" ? f.value.value as string : null; }
function fbNum(facts: Map<string, Fact[]>, e: TypedEntity, p: string) { return (e.stableId ? kbNum(facts, e.stableId, p) : null) ?? kbNum(facts, e.id, p); }
function fbText(facts: Map<string, Fact[]>, e: TypedEntity, p: string) { return (e.stableId ? kbText(facts, e.stableId, p) : null) ?? kbText(facts, e.id, p); }
function fbRef(facts: Map<string, Fact[]>, e: TypedEntity, p: string) { return (e.stableId ? kbRef(facts, e.stableId, p) : null) ?? kbRef(facts, e.id, p); }

function countSignals(s: Record<string, boolean>) { const t = Object.keys(s).length; return { filled: Object.values(s).filter(Boolean).length, total: t }; }

function computeForEntity(entity: TypedEntity, facts: Map<string, Fact[]>, orgPeople: Map<string, number>): CoverageScanItem {
  const now = new Date().toISOString();
  let score: number; let signals: Record<string, boolean>;
  switch (entity.entityType) {
    case "organization": {
      const i: OrgCoverageInput = { revenueNum: fbNum(facts, entity, "revenue"), valuationNum: fbNum(facts, entity, "valuation"), headcount: fbNum(facts, entity, "headcount"), totalFundingNum: fbNum(facts, entity, "total-funding"), foundedDate: fbText(facts, entity, "founded-date"), peopleCount: orgPeople.get(entity.stableId ?? entity.id) ?? 0, wikiPageId: entity.wikiId ?? null };
      score = computeOrgCoverage(i);
      signals = { revenue: i.revenueNum != null, valuation: i.valuationNum != null, headcount: i.headcount != null, totalFunding: i.totalFundingNum != null, foundedDate: !!i.foundedDate, peopleTen: (i.peopleCount ?? 0) >= 10, wikiPage: !!i.wikiPageId }; break;
    }
    case "person": case "researcher": {
      const i: PersonCoverageInput = { role: fbText(facts, entity, "role"), employerId: fbRef(facts, entity, "employed-by"), bornYear: fbNum(facts, entity, "born-year"), netWorthNum: fbNum(facts, entity, "net-worth"), wikiPageId: entity.wikiId ?? null };
      score = computePersonCoverage(i);
      signals = { role: !!i.role, employer: !!i.employerId, bornYear: i.bornYear != null, netWorth: i.netWorthNum != null, wikiPage: !!i.wikiPageId }; break;
    }
    case "ai-model": {
      const e = entity as Record<string, unknown>;
      const i = { developer: (e.developer as string) ?? null, releaseDate: (e.releaseDate as string) ?? null, contextWindow: (e.contextWindow as number) ?? null, parameterCount: (e.parameterCount as string) ?? null, safetyLevel: (e.safetyLevel as string) ?? null, wikiId: entity.wikiId ?? null };
      score = computeAiModelCoverage(i);
      signals = { pricing: i.contextWindow != null, contextWindow: i.contextWindow != null, parameterCount: !!i.parameterCount, safetyLevel: !!i.safetyLevel, wikiPage: !!i.wikiId }; break;
    }
    case "policy": {
      const e = entity as Record<string, unknown>;
      const i = { introduced: (e.introduced as string) ?? null, policyStatus: (e.policyStatus as string) ?? null, author: (e.author as string) ?? null, jurisdiction: (e.jurisdiction as string) ?? null, billNumber: (e.billNumber as string) ?? null, fullTextUrl: (e.fullTextUrl as string) ?? null, description: entity.description ?? null, tags: entity.tags, wikiId: entity.wikiId ?? null };
      score = computeLegislationCoverage(i);
      signals = { introduced: !!i.introduced, author: !!i.author, billNumber: !!i.billNumber, fullTextUrl: !!i.fullTextUrl, description: !!i.description, tags: (i.tags?.length ?? 0) >= 1, wikiPage: !!i.wikiId }; break;
    }
    case "project": {
      const e = entity as Record<string, unknown>;
      const i = { description: entity.description ?? null, status: (e.projectStatus as string) ?? null, website: (e.projectUrl as string) ?? null, orgName: (e.organization as string) ?? null, clusters: entity.clusters, wikiId: entity.wikiId ?? null };
      score = computeProjectCoverage(i);
      signals = { description: !!i.description, status: !!i.status, website: !!i.website, clusters: (i.clusters?.length ?? 0) >= 1, wikiPage: !!i.wikiId }; break;
    }
    case "benchmark": {
      const e = entity as Record<string, unknown>;
      const i = { category: (e.category as string) ?? null, scoringMethod: (e.scoringMethod as string) ?? null, maintainer: (e.maintainer as string) ?? null, description: entity.description ?? null, wikiId: entity.wikiId ?? null };
      score = computeBenchmarkCoverage(i);
      signals = { category: !!i.category, scoringMethod: !!i.scoringMethod, maintainer: !!i.maintainer, description: !!i.description, wikiPage: !!i.wikiId }; break;
    }
    default: {
      const i = { description: entity.description ?? null, tags: entity.tags, wikiId: entity.wikiId ?? null };
      score = computeGenericCoverage(i);
      signals = { description: !!i.description, tags: (i.tags?.length ?? 0) >= 1, wikiPage: !!i.wikiId }; break;
    }
  }
  const { filled, total } = countSignals(signals);
  return { entityType: entity.entityType, entityId: entity.id, coverageScore: score, signalsFilled: filled, signalsTotal: total, signals, scannedAt: now };
}

async function main() {
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || 200;
  const serverUrl = getServerUrl();
  const apiKey = getApiKey();
  if (!serverUrl) { console.error("Error: LONGTERMWIKI_SERVER_URL required"); process.exit(1); }
  if (!apiKey) { console.error("Error: LONGTERMWIKI_SERVER_API_KEY required"); process.exit(1); }

  console.log("Loading data...");
  const db = JSON.parse(readFileSync(DATABASE_JSON, "utf-8"));
  const entities: TypedEntity[] = db.typedEntities ?? [];
  console.log("  " + entities.length + " entities loaded");
  const facts = loadFactBase();
  console.log("  " + facts.size + " FactBase entities loaded");

  const orgPeople = new Map<string, number>();
  for (const [, ef] of facts) for (const f of ef) if (f.propertyId === "employed-by" && f.value.type === "ref") { const o = f.value.value as string; orgPeople.set(o, (orgPeople.get(o) ?? 0) + 1); }

  console.log("Computing coverage scores...");
  const items = entities.map((e) => computeForEntity(e, facts, orgPeople));
  const byScore = [0, 0, 0, 0, 0];
  for (const item of items) byScore[item.coverageScore]++;
  console.log("  Score distribution: 1=" + byScore[1] + ", 2=" + byScore[2] + ", 3=" + byScore[3] + ", 4=" + byScore[4]);

  if (dryRun) { console.log("Dry run: would sync " + items.length + " coverage scans"); return; }

  console.log("Syncing " + items.length + " coverage scans...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) { console.error("Server is not healthy, aborting"); process.exit(1); }
  const result = await batchSync(serverUrl + "/api/coverage-scans/sync", items, batchSize, { bodyKey: "items", responseCountKey: "upserted", itemLabel: "coverage scans" });
  console.log("\nDone: " + result.count + " synced, " + result.errors + " errors");
  if (result.errors > 0) process.exit(1);
}

main().catch((err) => { console.error("Fatal error:", err); process.exit(1); });
