import { describe, it, expect } from "vitest";
import {
  EPOCH_FILENAME_TO_SLUG,
  EPOCH_SKIP_FILES,
  getEpochSourceUrl,
} from "../benchmark-map.ts";

describe("EPOCH_FILENAME_TO_SLUG", () => {
  it("maps Epoch-run benchmarks to our slugs", () => {
    expect(EPOCH_FILENAME_TO_SLUG["gpqa_diamond"]).toBe("gpqa-diamond");
    expect(EPOCH_FILENAME_TO_SLUG["math_level_5"]).toBe("math-benchmark");
    expect(EPOCH_FILENAME_TO_SLUG["swe_bench_verified"]).toBe("swe-bench-verified");
    expect(EPOCH_FILENAME_TO_SLUG["frontiermath"]).toBe("frontiermath");
    expect(EPOCH_FILENAME_TO_SLUG["simpleqa_verified"]).toBe("simpleqa");
  });

  it("maps external benchmarks to our slugs", () => {
    expect(EPOCH_FILENAME_TO_SLUG["mmlu_external"]).toBe("mmlu");
    expect(EPOCH_FILENAME_TO_SLUG["bbh_external"]).toBe("bbh");
    expect(EPOCH_FILENAME_TO_SLUG["hella_swag_external"]).toBe("hellaswag");
    expect(EPOCH_FILENAME_TO_SLUG["gsm8k_external"]).toBe("gsm8k");
    expect(EPOCH_FILENAME_TO_SLUG["arc_agi_external"]).toBe("arc-agi");
    expect(EPOCH_FILENAME_TO_SLUG["hle_external"]).toBe("humanitys-last-exam");
  });

  it("has no undefined values", () => {
    for (const [key, value] of Object.entries(EPOCH_FILENAME_TO_SLUG)) {
      expect(value).toBeDefined();
      expect(typeof value).toBe("string");
      expect(value.length).toBeGreaterThan(0);
    }
  });
});

describe("EPOCH_SKIP_FILES", () => {
  it("skips the capabilities index and README", () => {
    expect(EPOCH_SKIP_FILES.has("epoch_capabilities_index")).toBe(true);
    expect(EPOCH_SKIP_FILES.has("README")).toBe(true);
  });

  it("does not skip benchmark files", () => {
    expect(EPOCH_SKIP_FILES.has("gpqa_diamond")).toBe(false);
    expect(EPOCH_SKIP_FILES.has("mmlu_external")).toBe(false);
  });
});

describe("getEpochSourceUrl", () => {
  it("generates a correct source URL with fragment", () => {
    const url = getEpochSourceUrl("gpqa_diamond");
    expect(url).toBe("https://epoch.ai/data/benchmark_data.zip#gpqa_diamond.csv");
  });
});
