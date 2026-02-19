import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { getPricing } from "./pricing.js";

const LOGS_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOGS_DIR, "queries.jsonl");

export interface QueryLog {
  timestamp: string;
  question: string;
  userId?: string;
  userName?: string;
  responseLength: number;
  durationMs: number;
  toolCalls: string[];
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheCreationTokens?: number;
  model?: string;
  estimatedCostUsd: number;
  success: boolean;
  error?: string;
}

export function ensureLogsDir(): void {
  if (!existsSync(LOGS_DIR)) {
    mkdirSync(LOGS_DIR, { recursive: true });
  }
}

export function calculateCost(
  inputTokens: number,
  outputTokens: number,
  model?: string,
  cacheReadTokens?: number
): number {
  const pricing = getPricing(model);
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  const cacheReadCost = ((cacheReadTokens ?? 0) / 1_000_000) * pricing.cacheRead;
  return inputCost + outputCost + cacheReadCost;
}

export function logQuery(log: QueryLog): void {
  ensureLogsDir();
  appendFileSync(LOG_FILE, JSON.stringify(log) + "\n");
}

export function formatCost(costUsd: number): string {
  if (costUsd < 0.01) {
    return `${(costUsd * 100).toFixed(2)}¢`;
  }
  return `$${costUsd.toFixed(4)}`;
}

export function formatLogSummary(log: QueryLog): string {
  return [
    `📊 Query Stats:`,
    `   Duration: ${(log.durationMs / 1000).toFixed(1)}s`,
    `   Tokens: ${log.inputTokens.toLocaleString()} in / ${log.outputTokens.toLocaleString()} out`,
    log.cacheReadTokens
      ? `   Cache read: ${log.cacheReadTokens.toLocaleString()}`
      : null,
    `   Tools: ${log.toolCalls.length} calls`,
    `   Cost: ${formatCost(log.estimatedCostUsd)}`,
  ]
    .filter(Boolean)
    .join("\n");
}
