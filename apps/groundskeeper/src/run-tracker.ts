import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { dirname } from "path";
import type { Config } from "./config.js";

export interface RunRecord {
  taskName: string;
  timestamp: string;
  durationMs: number;
  success: boolean;
  error?: string;
  summary?: string;
}

interface RunLog {
  runs: RunRecord[];
  dailyCounts: Record<string, number>; // date string -> count of AI invocations
}

function todayKey(): string {
  return new Date().toISOString().slice(0, 10); // YYYY-MM-DD in UTC
}

function loadLog(path: string): RunLog {
  if (!existsSync(path)) {
    return { runs: [], dailyCounts: {} };
  }
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return { runs: [], dailyCounts: {} };
  }
}

function saveLog(path: string, log: RunLog): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  writeFileSync(path, JSON.stringify(log, null, 2));
}

export function recordRun(config: Config, record: RunRecord): void {
  const log = loadLog(config.runLogPath);

  // Keep last 200 runs to avoid unbounded growth
  log.runs.push(record);
  if (log.runs.length > 200) {
    log.runs = log.runs.slice(-200);
  }

  saveLog(config.runLogPath, log);
}

export function incrementDailyAiCount(config: Config): void {
  const log = loadLog(config.runLogPath);
  const key = todayKey();
  log.dailyCounts[key] = (log.dailyCounts[key] ?? 0) + 1;

  // Clean up old date entries (keep last 7 days)
  const keys = Object.keys(log.dailyCounts).sort();
  while (keys.length > 7) {
    const oldKey = keys.shift()!;
    delete log.dailyCounts[oldKey];
  }

  saveLog(config.runLogPath, log);
}

export function getDailyAiCount(config: Config): number {
  const log = loadLog(config.runLogPath);
  return log.dailyCounts[todayKey()] ?? 0;
}

export function isDailyCapReached(config: Config): boolean {
  return getDailyAiCount(config) >= config.dailyRunCap;
}

export function getRecentRuns(
  config: Config,
  taskName?: string,
  limit = 10
): RunRecord[] {
  const log = loadLog(config.runLogPath);
  let runs = log.runs;
  if (taskName) {
    runs = runs.filter((r) => r.taskName === taskName);
  }
  return runs.slice(-limit);
}
