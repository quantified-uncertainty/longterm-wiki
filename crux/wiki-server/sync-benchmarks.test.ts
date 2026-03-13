import { describe, it, expect, vi, beforeEach } from "vitest";
import { createHash } from "crypto";

// Mock fs before importing the module under test
vi.mock("fs", () => ({
  readFileSync: vi.fn(),
}));

import { readFileSync } from "fs";
import { loadBenchmarks, loadBenchmarkResults } from "./sync-benchmarks.ts";

const mockReadFileSync = vi.mocked(readFileSync);

// Helper: compute the same deterministic ID that generateResultId produces
function expectedResultId(benchmarkId: string, modelId: string): string {
  return createHash("md5")
    .update(`br:${benchmarkId}:${modelId}`)
    .digest("hex")
    .slice(0, 10);
}

beforeEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// generateResultId — tested indirectly through loadBenchmarkResults
// ---------------------------------------------------------------------------
describe("generateResultId (via loadBenchmarkResults)", () => {
  it("produces a deterministic 10-char hex ID from (benchmarkId, modelId)", () => {
    // Provide a benchmarks set containing "mmlu"
    const benchmarkIds = new Set(["mmlu"]);

    // Mock ai-models.yaml with one model that has an "mmlu" benchmark entry
    mockReadFileSync.mockReturnValue(`
- id: gpt-4
  type: ai-model
  title: GPT-4
  benchmarks:
    - name: MMLU
      score: 86.4
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe(expectedResultId("mmlu", "gpt-4"));
    expect(results[0].id).toHaveLength(10);
    expect(results[0].id).toBe("8f0fc62a0d");
  });

  it("produces different IDs for different (benchmarkId, modelId) pairs", () => {
    const benchmarkIds = new Set(["mmlu", "gpqa-diamond"]);

    mockReadFileSync.mockReturnValue(`
- id: gpt-4
  type: ai-model
  title: GPT-4
  benchmarks:
    - name: MMLU
      score: 86.4
    - name: GPQA Diamond
      score: 50.2
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(2);

    const ids = results.map((r) => r.id);
    expect(ids[0]).not.toBe(ids[1]);
    expect(ids[0]).toBe(expectedResultId("mmlu", "gpt-4"));
    expect(ids[1]).toBe(expectedResultId("gpqa-diamond", "gpt-4"));
  });

  it("is stable across calls with the same inputs", () => {
    const benchmarkIds = new Set(["mmlu"]);

    const yaml = `
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: mmlu
      score: 90
`;
    mockReadFileSync.mockReturnValue(yaml);
    const first = loadBenchmarkResults(benchmarkIds);

    mockReadFileSync.mockReturnValue(yaml);
    const second = loadBenchmarkResults(benchmarkIds);

    expect(first[0].id).toBe(second[0].id);
  });
});

// ---------------------------------------------------------------------------
// loadBenchmarks
// ---------------------------------------------------------------------------
describe("loadBenchmarks", () => {
  it("loads and filters benchmark entities from YAML", () => {
    mockReadFileSync.mockReturnValue(`
- id: mmlu
  type: benchmark
  title: MMLU
  category: knowledge
  description: Massive Multitask Language Understanding
  scoringMethod: accuracy
  higherIsBetter: true
- id: swe-bench-verified
  type: benchmark
  title: SWE-bench Verified
  category: coding
`);

    const benchmarks = loadBenchmarks();
    expect(benchmarks).toHaveLength(2);
    expect(benchmarks[0].id).toBe("mmlu");
    expect(benchmarks[0].title).toBe("MMLU");
    expect(benchmarks[1].id).toBe("swe-bench-verified");
  });

  it("filters out entries that are not type=benchmark", () => {
    mockReadFileSync.mockReturnValue(`
- id: mmlu
  type: benchmark
  title: MMLU
- id: gpt-4
  type: ai-model
  title: GPT-4
`);

    const benchmarks = loadBenchmarks();
    expect(benchmarks).toHaveLength(1);
    expect(benchmarks[0].id).toBe("mmlu");
  });

  it("filters out entries missing an id", () => {
    mockReadFileSync.mockReturnValue(`
- type: benchmark
  title: No ID Benchmark
- id: valid
  type: benchmark
  title: Valid Benchmark
`);

    const benchmarks = loadBenchmarks();
    expect(benchmarks).toHaveLength(1);
    expect(benchmarks[0].id).toBe("valid");
  });

  it("filters out entries missing a title", () => {
    mockReadFileSync.mockReturnValue(`
- id: no-title
  type: benchmark
- id: valid
  type: benchmark
  title: Valid
`);

    const benchmarks = loadBenchmarks();
    expect(benchmarks).toHaveLength(1);
    expect(benchmarks[0].id).toBe("valid");
  });

  it("returns empty array for non-array YAML", () => {
    mockReadFileSync.mockReturnValue(`
key: value
nested:
  data: true
`);

    const benchmarks = loadBenchmarks();
    expect(benchmarks).toEqual([]);
  });

  it("returns empty array for empty YAML", () => {
    mockReadFileSync.mockReturnValue("[]");

    const benchmarks = loadBenchmarks();
    expect(benchmarks).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// loadBenchmarkResults
// ---------------------------------------------------------------------------
describe("loadBenchmarkResults", () => {
  it("extracts benchmark results from ai-model entities", () => {
    const benchmarkIds = new Set(["mmlu", "gpqa-diamond"]);

    mockReadFileSync.mockReturnValue(`
- id: gpt-4
  type: ai-model
  title: GPT-4
  benchmarks:
    - name: MMLU
      score: 86.4
    - name: GPQA Diamond
      score: 50.2
      unit: "%"
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(2);

    expect(results[0]).toEqual({
      id: expectedResultId("mmlu", "gpt-4"),
      benchmarkId: "mmlu",
      modelId: "gpt-4",
      score: 86.4,
      unit: null,
      date: null,
      sourceUrl: null,
      notes: null,
    });

    expect(results[1]).toEqual({
      id: expectedResultId("gpqa-diamond", "gpt-4"),
      benchmarkId: "gpqa-diamond",
      modelId: "gpt-4",
      score: 50.2,
      unit: "%",
      date: null,
      sourceUrl: null,
      notes: null,
    });
  });

  it("skips models without benchmarks array", () => {
    const benchmarkIds = new Set(["mmlu"]);

    mockReadFileSync.mockReturnValue(`
- id: model-no-benchmarks
  type: ai-model
  title: No Benchmarks Model
- id: model-with
  type: ai-model
  title: With Benchmarks
  benchmarks:
    - name: MMLU
      score: 80
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].modelId).toBe("model-with");
  });

  it("skips non-ai-model entities", () => {
    const benchmarkIds = new Set(["mmlu"]);

    mockReadFileSync.mockReturnValue(`
- id: some-org
  type: organization
  title: Some Org
  benchmarks:
    - name: MMLU
      score: 99
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: MMLU
      score: 85
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].modelId).toBe("model-a");
  });

  it("skips benchmark names not in the benchmarkIds set", () => {
    const benchmarkIds = new Set(["mmlu"]);

    mockReadFileSync.mockReturnValue(`
- id: gpt-4
  type: ai-model
  title: GPT-4
  benchmarks:
    - name: MMLU
      score: 86.4
    - name: unknown-benchmark
      score: 42
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkId).toBe("mmlu");
  });

  it("returns empty array for non-array YAML", () => {
    mockReadFileSync.mockReturnValue("key: value");
    const results = loadBenchmarkResults(new Set(["mmlu"]));
    expect(results).toEqual([]);
  });

  it("handles zero-score benchmarks", () => {
    const benchmarkIds = new Set(["mmlu"]);

    mockReadFileSync.mockReturnValue(`
- id: bad-model
  type: ai-model
  title: Bad Model
  benchmarks:
    - name: MMLU
      score: 0
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].score).toBe(0);
  });

  it("sets unit to null when not provided", () => {
    const benchmarkIds = new Set(["mmlu"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: MMLU
      score: 80
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results[0].unit).toBeNull();
  });

  it("preserves unit when provided", () => {
    const benchmarkIds = new Set(["mmlu"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: MMLU
      score: 80
      unit: "%"
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results[0].unit).toBe("%");
  });

  it("handles multiple models with the same benchmark", () => {
    const benchmarkIds = new Set(["mmlu"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: MMLU
      score: 80
- id: model-b
  type: ai-model
  title: Model B
  benchmarks:
    - name: MMLU
      score: 90
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(2);
    expect(results[0].modelId).toBe("model-a");
    expect(results[1].modelId).toBe("model-b");
    // Different models produce different IDs
    expect(results[0].id).not.toBe(results[1].id);
  });
});

// ---------------------------------------------------------------------------
// BENCHMARK_NAME_ALIASES — tested via loadBenchmarkResults alias resolution
// ---------------------------------------------------------------------------
describe("BENCHMARK_NAME_ALIASES (via loadBenchmarkResults)", () => {
  it("resolves 'swe-bench' alias to 'swe-bench-verified'", () => {
    const benchmarkIds = new Set(["swe-bench-verified"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: swe-bench
      score: 45.2
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkId).toBe("swe-bench-verified");
  });

  it("resolves 'SWE-bench Verified' alias (case-insensitive)", () => {
    const benchmarkIds = new Set(["swe-bench-verified"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: SWE-bench Verified
      score: 48
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkId).toBe("swe-bench-verified");
  });

  it("resolves 'math' alias to 'math-benchmark'", () => {
    const benchmarkIds = new Set(["math-benchmark"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: MATH
      score: 67.5
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkId).toBe("math-benchmark");
  });

  it("resolves 'gpqa' alias to 'gpqa-diamond'", () => {
    const benchmarkIds = new Set(["gpqa-diamond"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: gpqa
      score: 55
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkId).toBe("gpqa-diamond");
  });

  it("resolves 'aime' alias to 'aime-2025'", () => {
    const benchmarkIds = new Set(["aime-2025"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: aime
      score: 72
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkId).toBe("aime-2025");
  });

  it("resolves direct benchmark ID match (not just aliases)", () => {
    const benchmarkIds = new Set(["mmlu"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: mmlu
      score: 88
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkId).toBe("mmlu");
  });

  it("does not resolve aliases when the target slug is not in benchmarkIds", () => {
    // Only "mmlu" is in the set, not "swe-bench-verified"
    const benchmarkIds = new Set(["mmlu"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: swe-bench
      score: 45
    - name: MMLU
      score: 80
`);

    const results = loadBenchmarkResults(benchmarkIds);
    // Only MMLU should resolve; swe-bench alias target isn't in benchmarkIds
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkId).toBe("mmlu");
  });

  it("handles case-insensitive benchmark name matching", () => {
    const benchmarkIds = new Set(["humaneval"]);

    mockReadFileSync.mockReturnValue(`
- id: model-a
  type: ai-model
  title: Model A
  benchmarks:
    - name: HumanEval
      score: 78.5
`);

    const results = loadBenchmarkResults(benchmarkIds);
    expect(results).toHaveLength(1);
    expect(results[0].benchmarkId).toBe("humaneval");
  });
});

// ---------------------------------------------------------------------------
// transformBenchmark — tested indirectly via known field mapping behavior
// (transformBenchmark is not exported, but loadBenchmarks returns the raw
// YamlBenchmark objects which main() then maps through transformBenchmark;
// we verify the transformation logic by documenting expected behavior)
// ---------------------------------------------------------------------------
describe("transformBenchmark (field mapping documentation)", () => {
  // Since transformBenchmark is not exported, these tests document
  // the expected transformation contract based on the source code.
  // The actual mapping is: id→id, id→slug, title→name,
  // category→category, description→description, website→website,
  // scoringMethod→scoringMethod, higherIsBetter→higherIsBetter (default true),
  // introducedDate→introducedDate, maintainer→maintainer,
  // sources[0].url→source.
  //
  // These tests verify the input shape (YamlBenchmark) that loadBenchmarks
  // returns is compatible with the transform expectations.

  it("loadBenchmarks returns objects with required transform input fields", () => {
    mockReadFileSync.mockReturnValue(`
- id: mmlu
  type: benchmark
  title: MMLU
  category: knowledge
  description: Massive Multitask Language Understanding
  scoringMethod: accuracy
  higherIsBetter: true
  introducedDate: "2021-01-01"
  maintainer: Hendrycks et al.
  website: https://example.com
  sources:
    - title: Paper
      url: https://arxiv.org/abs/2009.03300
`);

    const benchmarks = loadBenchmarks();
    expect(benchmarks).toHaveLength(1);

    const b = benchmarks[0];
    expect(b.id).toBe("mmlu");
    expect(b.title).toBe("MMLU");
    expect(b.category).toBe("knowledge");
    expect(b.description).toBe("Massive Multitask Language Understanding");
    expect(b.scoringMethod).toBe("accuracy");
    expect(b.higherIsBetter).toBe(true);
    expect(b.introducedDate).toBe("2021-01-01");
    expect(b.maintainer).toBe("Hendrycks et al.");
    expect(b.website).toBe("https://example.com");
    expect(b.sources).toEqual([
      { title: "Paper", url: "https://arxiv.org/abs/2009.03300" },
    ]);
  });

  it("loadBenchmarks returns objects with optional fields undefined", () => {
    mockReadFileSync.mockReturnValue(`
- id: minimal
  type: benchmark
  title: Minimal Benchmark
`);

    const benchmarks = loadBenchmarks();
    expect(benchmarks).toHaveLength(1);

    const b = benchmarks[0];
    expect(b.id).toBe("minimal");
    expect(b.title).toBe("Minimal Benchmark");
    // Optional fields should be undefined (transformBenchmark converts to null)
    expect(b.category).toBeUndefined();
    expect(b.description).toBeUndefined();
    expect(b.website).toBeUndefined();
    expect(b.scoringMethod).toBeUndefined();
    expect(b.higherIsBetter).toBeUndefined();
    expect(b.introducedDate).toBeUndefined();
    expect(b.maintainer).toBeUndefined();
    expect(b.sources).toBeUndefined();
  });
});
