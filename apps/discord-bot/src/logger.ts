import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";

const LOGS_DIR = join(process.cwd(), "logs");
const LOG_FILE = join(LOGS_DIR, "queries.jsonl");

// Claude pricing per 1M tokens
const PRICING: Record<string, { input: number; output: number }> = {
  "claude-opus-4-6": { input: 5.0, output: 25.0 },
  "claude-sonnet-4-20250514": { input: 3.0, output: 15.0 },
  "claude-3-5-sonnet-20241022": { input: 3.0, output: 15.0 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4.0 },
  default: { input: 3.0, output: 15.0 },
};

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
  model?: string
): number {
  const pricing = (model && PRICING[model]) || PRICING["default"]!;
  const inputCost = (inputTokens / 1_000_000) * pricing.input;
  const outputCost = (outputTokens / 1_000_000) * pricing.output;
  return inputCost + outputCost;
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
