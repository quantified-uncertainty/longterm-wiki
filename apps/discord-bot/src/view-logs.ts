import { readFileSync, existsSync } from "fs";
import { join } from "path";
import { QueryLog, formatCost } from "./logger.js";

const LOGS_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOGS_DIR, "queries.jsonl");

function loadLogs(): QueryLog[] {
  if (!existsSync(LOG_FILE)) {
    console.log("No logs found yet.");
    return [];
  }

  const content = readFileSync(LOG_FILE, "utf-8");
  const lines = content.trim().split("\n").filter(Boolean);
  return lines.map((line) => JSON.parse(line) as QueryLog);
}

function printSummary(logs: QueryLog[]): void {
  if (logs.length === 0) return;

  const successful = logs.filter((l) => l.success);
  const failed = logs.filter((l) => !l.success);

  const totalCost = successful.reduce((sum, l) => sum + l.estimatedCostUsd, 0);
  const totalInputTokens = successful.reduce((sum, l) => sum + l.inputTokens, 0);
  const totalOutputTokens = successful.reduce(
    (sum, l) => sum + l.outputTokens,
    0
  );
  const avgDuration =
    successful.reduce((sum, l) => sum + l.durationMs, 0) / successful.length;
  const avgCost = totalCost / successful.length;

  console.log("\n" + "=".repeat(60));
  console.log("📊 QUERY LOG SUMMARY");
  console.log("=".repeat(60));
  console.log(
    `\nTotal queries: ${logs.length} (${successful.length} successful, ${failed.length} failed)`
  );
  console.log(`\n💰 Cost:`);
  console.log(`   Total: ${formatCost(totalCost)}`);
  console.log(`   Average: ${formatCost(avgCost)} per query`);
  console.log(`\n📈 Tokens:`);
  console.log(`   Input: ${totalInputTokens.toLocaleString()}`);
  console.log(`   Output: ${totalOutputTokens.toLocaleString()}`);
  console.log(`\n⏱️  Performance:`);
  console.log(`   Avg duration: ${(avgDuration / 1000).toFixed(1)}s`);
}

function printRecentLogs(logs: QueryLog[], count: number = 10): void {
  const recent = logs.slice(-count).reverse();

  console.log(`\n📝 Last ${Math.min(count, logs.length)} queries:`);
  console.log("-".repeat(60));

  for (const log of recent) {
    const time = new Date(log.timestamp).toLocaleString();
    const status = log.success ? "✅" : "❌";
    const duration = (log.durationMs / 1000).toFixed(1);
    const cost = formatCost(log.estimatedCostUsd);

    console.log(`\n${status} [${time}] ${log.userName || "unknown"}`);
    console.log(
      `   Q: "${log.question.slice(0, 60)}${log.question.length > 60 ? "..." : ""}"`
    );
    if (log.success) {
      console.log(
        `   ${duration}s | ${log.toolCalls.length} tools | ${log.inputTokens + log.outputTokens} tokens | ${cost}`
      );
    } else {
      console.log(`   Error: ${log.error}`);
    }
  }
}

function printDailyCosts(logs: QueryLog[]): void {
  const byDay = new Map<string, { count: number; cost: number }>();

  for (const log of logs) {
    const day = log.timestamp.split("T")[0]!;
    const existing = byDay.get(day) || { count: 0, cost: 0 };
    byDay.set(day, {
      count: existing.count + 1,
      cost: existing.cost + log.estimatedCostUsd,
    });
  }

  console.log("\n📅 Daily breakdown:");
  console.log("-".repeat(40));

  const sorted = [...byDay.entries()].sort((a, b) => b[0].localeCompare(a[0]));
  for (const [day, data] of sorted.slice(0, 7)) {
    console.log(`   ${day}: ${data.count} queries, ${formatCost(data.cost)}`);
  }
}

const args = process.argv.slice(2);
const showAll = args.includes("--all");
const count = parseInt(args.find((a) => !a.startsWith("--")) || "10", 10);

const logs = loadLogs();

if (logs.length > 0) {
  printSummary(logs);
  printDailyCosts(logs);
  printRecentLogs(logs, showAll ? logs.length : count);
}
