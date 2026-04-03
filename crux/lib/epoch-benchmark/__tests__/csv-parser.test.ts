import { describe, it, expect } from "vitest";
import { parseEpochBenchmarkCsv } from "../csv-parser.ts";

describe("parseEpochBenchmarkCsv", () => {
  it("parses a standard Epoch-run benchmark CSV (mean_score)", () => {
    const csv = `Model version,mean_score,Best score (across scorers),Release date,Organization
claude-sonnet-4-6_32K,0.8737,0.8737,2026-02-17,Anthropic
gpt-5.4-2026-03-05_xhigh,0.946,0.946,2026-03-05,OpenAI`;

    const rows = parseEpochBenchmarkCsv(csv);
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({
      modelVersion: "claude-sonnet-4-6_32K",
      score: 0.8737,
      releaseDate: "2026-02-17",
      organization: "Anthropic",
    });
    expect(rows[1]).toEqual({
      modelVersion: "gpt-5.4-2026-03-05_xhigh",
      score: 0.946,
      releaseDate: "2026-03-05",
      organization: "OpenAI",
    });
  });

  it("parses an external benchmark CSV (Score column)", () => {
    const csv = `Model version,Score,Release date,Organization,Country
test-model,0.85,2025-01-01,TestOrg,US`;

    const rows = parseEpochBenchmarkCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].modelVersion).toBe("test-model");
    expect(rows[0].score).toBe(0.85);
  });

  it("parses EM (exact match) score column", () => {
    const csv = `Model version,EM,Release date,Organization,Country
model-a,0.77,2024-12-03,Amazon,US`;

    const rows = parseEpochBenchmarkCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].score).toBe(0.77);
  });

  it("skips rows with non-numeric scores", () => {
    const csv = `Model version,mean_score,Release date,Organization
valid-model,0.5,2025-01-01,Org
invalid-model,,2025-01-01,Org
another-invalid,N/A,2025-01-01,Org`;

    const rows = parseEpochBenchmarkCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].modelVersion).toBe("valid-model");
  });

  it("skips rows where model version looks like a URL", () => {
    const csv = `Model version,mean_score,Release date,Organization
https://example.com/something,0.5,2025-01-01,Org
real-model,0.7,2025-01-01,Org`;

    const rows = parseEpochBenchmarkCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].modelVersion).toBe("real-model");
  });

  it("handles missing optional columns gracefully", () => {
    const csv = `Model version,Score
model-x,0.92`;

    const rows = parseEpochBenchmarkCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].releaseDate).toBeNull();
    expect(rows[0].organization).toBeNull();
  });

  it("returns empty array for empty input", () => {
    expect(parseEpochBenchmarkCsv("")).toEqual([]);
    expect(parseEpochBenchmarkCsv("Model version")).toEqual([]);
  });

  it("handles quoted fields with commas", () => {
    const csv = `Model version,Score,Release date,Organization,Country
"Model, with comma",0.88,2025-01-01,Org,US`;

    const rows = parseEpochBenchmarkCsv(csv);
    expect(rows).toHaveLength(1);
    expect(rows[0].modelVersion).toBe("Model, with comma");
    expect(rows[0].score).toBe(0.88);
  });
});
