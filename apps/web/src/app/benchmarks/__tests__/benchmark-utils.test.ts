/**
 * Tests for getBenchmarkResultsFromModels — specifically the merge behavior
 * that fixes GitHub issue #2633: benchmark leaderboards showing "0 models tested"
 * when PG has some data but not all benchmarks.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AnyEntity } from "@/data/tablebase";

// Mock @/data before importing benchmark-utils
vi.mock("@/data", () => ({
  getTypedEntities: vi.fn(),
  getBenchmarkResults: vi.fn(),
  isBenchmark: (e: AnyEntity) => (e as { entityType: string }).entityType === "benchmark",
  isAiModel: (e: AnyEntity) => (e as { entityType: string }).entityType === "ai-model",
}));

import { getTypedEntities, getBenchmarkResults } from "@/data";
import { getBenchmarkResultsFromModels } from "../benchmark-utils";

const mockGetTypedEntities = vi.mocked(getTypedEntities);
const mockGetBenchmarkResults = vi.mocked(getBenchmarkResults);

// --- Test data factories ---

function makeAiModel(
  id: string,
  title: string,
  benchmarks: Array<{ name: string; score: number; unit?: string }> = [],
): AnyEntity {
  return {
    id,
    title,
    entityType: "ai-model" as const,
    developer: undefined,
    wikiId: null,
    benchmarks,
    tags: [],
    description: undefined,
    relatedEntries: [],
  } as unknown as AnyEntity;
}

function makeBenchmark(id: string, title: string): AnyEntity {
  return {
    id,
    title,
    entityType: "benchmark" as const,
    tags: [],
    wikiId: null,
    description: undefined,
    relatedEntries: [],
  } as unknown as AnyEntity;
}

function makePGResult(benchmarkId: string, score: number, unit: string | null = null) {
  return { benchmarkId, score, unit, date: null, sourceUrl: null };
}

beforeEach(() => {
  vi.clearAllMocks();

  // Default: empty entities and no PG data
  mockGetTypedEntities.mockReturnValue([]);
  mockGetBenchmarkResults.mockReturnValue({});
});

// ---------------------------------------------------------------------------
// Core behavior: no PG data → inline data only
// ---------------------------------------------------------------------------
describe("getBenchmarkResultsFromModels — no PG data", () => {
  it("returns inline benchmark scores when PG data is empty", () => {
    mockGetTypedEntities.mockReturnValue([
      makeBenchmark("aime-2025", "AIME 2025"),
      makeAiModel("o3", "o3", [{ name: "AIME 2025", score: 86.5, unit: "%" }]),
    ]);
    mockGetBenchmarkResults.mockReturnValue({});

    const results = getBenchmarkResultsFromModels();
    const aimeResults = results.get("aime-2025");
    expect(aimeResults).toBeDefined();
    expect(aimeResults).toHaveLength(1);
    expect(aimeResults![0].modelId).toBe("o3");
    expect(aimeResults![0].score).toBe(86.5);
  });

  it("returns empty map when no models have benchmarks", () => {
    mockGetTypedEntities.mockReturnValue([
      makeBenchmark("mmlu", "MMLU"),
      makeAiModel("gpt-4", "GPT-4", []),
    ]);
    mockGetBenchmarkResults.mockReturnValue({});

    const results = getBenchmarkResultsFromModels();
    expect(results.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Core bug fix: PG has some data but not these benchmarks → should still show inline
// ---------------------------------------------------------------------------
describe("getBenchmarkResultsFromModels — partial PG data (the bug)", () => {
  it("shows inline results for benchmarks absent from PG when PG has other data", () => {
    // This is the bug scenario: PG has data for mmlu but NOT for aime-2025.
    // Before the fix, aime-2025 would show "0 models" because hasPGData=true
    // and the fallback to inline data was skipped entirely.
    mockGetTypedEntities.mockReturnValue([
      makeBenchmark("mmlu", "MMLU"),
      makeBenchmark("aime-2025", "AIME 2025"),
      makeAiModel("gpt-4", "GPT-4", [{ name: "MMLU", score: 86.4, unit: "%" }]),
      makeAiModel("o3", "o3", [
        { name: "AIME 2025", score: 86.5, unit: "%" },
        { name: "MMLU", score: 88, unit: "%" },
      ]),
    ]);

    // PG has data for some-pg-benchmark-id but NOT for aime-2025
    mockGetBenchmarkResults.mockReturnValue({
      "gpt-4": [makePGResult("some-pg-benchmark-id", 87.0, "%")],
    });

    const results = getBenchmarkResultsFromModels();

    // aime-2025 should appear via inline data (o3's score)
    const aimeResults = results.get("aime-2025");
    expect(aimeResults).toBeDefined();
    expect(aimeResults!.length).toBeGreaterThan(0);
    expect(aimeResults![0].modelId).toBe("o3");
    expect(aimeResults![0].score).toBe(86.5);
  });

  it("shows inline results for all 10 affected benchmark types when PG has other data", () => {
    const affectedBenchmarks = [
      { name: "AIME 2025", slug: "aime-2025" },
      { name: "MGSM", slug: "mgsm" },
      { name: "Chatbot Arena Elo", slug: "chatbot-arena-elo" },
      { name: "Humanity's Last Exam", slug: "humanitys-last-exam" },
      { name: "MathVista", slug: "mathvista" },
      { name: "TAU-bench", slug: "tau-bench" },
      { name: "MLE-bench", slug: "mle-bench" },
      { name: "WebArena", slug: "webarena" },
      { name: "LiveBench", slug: "livebench" },
      { name: "BFCL", slug: "bfcl" },
    ];

    // One model has all 10 benchmark scores inline
    const modelBenchmarks = affectedBenchmarks.map((b) => ({
      name: b.name,
      score: 75.0,
      unit: "%",
    }));

    mockGetTypedEntities.mockReturnValue([
      makeBenchmark("mmlu", "MMLU"),
      ...affectedBenchmarks.map((b) => makeBenchmark(b.slug, b.name)),
      makeAiModel("test-model", "Test Model", modelBenchmarks),
    ]);

    // PG has ONLY mmlu data — the 10 affected benchmarks are absent from PG
    mockGetBenchmarkResults.mockReturnValue({
      "some-other-model": [makePGResult("mmlu", 90, "%")],
    });

    const results = getBenchmarkResultsFromModels();

    for (const { slug } of affectedBenchmarks) {
      const rows = results.get(slug);
      expect(rows, `${slug} should have results`).toBeDefined();
      expect(rows!.length, `${slug} should have at least 1 model`).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// PG data takes priority over inline for covered (benchmark, model) pairs
// ---------------------------------------------------------------------------
describe("getBenchmarkResultsFromModels — PG data takes priority", () => {
  it("uses PG score (not inline) for a (benchmark, model) pair covered by PG", () => {
    mockGetTypedEntities.mockReturnValue([
      makeBenchmark("mmlu", "MMLU"),
      makeAiModel("gpt-4", "GPT-4", [{ name: "MMLU", score: 86.4, unit: "%" }]),
    ]);

    // PG has a different score for the same (gpt-4, mmlu) pair
    mockGetBenchmarkResults.mockReturnValue({
      "gpt-4": [makePGResult("mmlu", 87.5, "%")],
    });

    const results = getBenchmarkResultsFromModels();
    const mmluResults = results.get("mmlu");
    expect(mmluResults).toBeDefined();
    expect(mmluResults).toHaveLength(1);
    // PG score wins
    expect(mmluResults![0].score).toBe(87.5);
  });

  it("does not duplicate results when both PG and inline have the same (benchmark, model) pair", () => {
    mockGetTypedEntities.mockReturnValue([
      makeBenchmark("mmlu", "MMLU"),
      makeAiModel("gpt-4", "GPT-4", [{ name: "MMLU", score: 86.4 }]),
    ]);

    mockGetBenchmarkResults.mockReturnValue({
      "gpt-4": [makePGResult("mmlu", 87.5, "%")],
    });

    const results = getBenchmarkResultsFromModels();
    const mmluResults = results.get("mmlu");
    // Should be exactly 1 entry, not 2
    expect(mmluResults).toHaveLength(1);
  });

  it("keeps inline results for models not in PG, while using PG for models in PG", () => {
    mockGetTypedEntities.mockReturnValue([
      makeBenchmark("mmlu", "MMLU"),
      makeAiModel("gpt-4", "GPT-4", [{ name: "MMLU", score: 86.4 }]),
      makeAiModel("claude-3", "Claude 3", [{ name: "MMLU", score: 82.0 }]),
    ]);

    // PG only has gpt-4, not claude-3
    mockGetBenchmarkResults.mockReturnValue({
      "gpt-4": [makePGResult("mmlu", 87.5, "%")],
    });

    const results = getBenchmarkResultsFromModels();
    const mmluResults = results.get("mmlu");
    expect(mmluResults).toBeDefined();
    expect(mmluResults).toHaveLength(2);

    const gpt4Result = mmluResults!.find((r) => r.modelId === "gpt-4");
    const claudeResult = mmluResults!.find((r) => r.modelId === "claude-3");

    // gpt-4 uses PG score
    expect(gpt4Result).toBeDefined();
    expect(gpt4Result!.score).toBe(87.5);

    // claude-3 uses inline score
    expect(claudeResult).toBeDefined();
    expect(claudeResult!.score).toBe(82.0);
  });
});

// ---------------------------------------------------------------------------
// Alias resolution still works
// ---------------------------------------------------------------------------
describe("getBenchmarkResultsFromModels — alias resolution", () => {
  it("resolves \"Humanity's Last Exam\" alias to 'humanitys-last-exam'", () => {
    mockGetTypedEntities.mockReturnValue([
      makeBenchmark("humanitys-last-exam", "Humanity's Last Exam"),
      makeAiModel("model-a", "Model A", [{ name: "Humanity's Last Exam", score: 30.5 }]),
    ]);
    mockGetBenchmarkResults.mockReturnValue({});

    const results = getBenchmarkResultsFromModels();
    expect(results.get("humanitys-last-exam")).toHaveLength(1);
  });

  it("resolves 'Chatbot Arena Elo' alias to 'chatbot-arena-elo'", () => {
    mockGetTypedEntities.mockReturnValue([
      makeBenchmark("chatbot-arena-elo", "Chatbot Arena Elo"),
      makeAiModel("model-a", "Model A", [{ name: "Chatbot Arena Elo", score: 1280 }]),
    ]);
    mockGetBenchmarkResults.mockReturnValue({});

    const results = getBenchmarkResultsFromModels();
    expect(results.get("chatbot-arena-elo")).toHaveLength(1);
  });
});
