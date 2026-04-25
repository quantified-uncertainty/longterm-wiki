/**
 * Unit tests for system-card-benchmark-linker (QUA-702).
 *
 * Focus on the pure logic — name normalization and lookup resolution.
 * Integration with the postUpsert hook is exercised by sync-factory tests
 * + the existing model-system-cards integration test surface.
 */

import { describe, expect, test } from "vitest";
import { normalizeBenchmarkName } from "../routes/tablebase/system-card-benchmark-linker";

describe("normalizeBenchmarkName", () => {
  test("lowercases", () => {
    expect(normalizeBenchmarkName("MMLU")).toBe("mmlu");
  });

  test("strips hyphens, dashes, dots", () => {
    expect(normalizeBenchmarkName("SWE-bench Verified")).toBe(
      "swebenchverified",
    );
    expect(normalizeBenchmarkName("MMLU-Pro")).toBe("mmlupro");
    expect(normalizeBenchmarkName("GPQA-Diamond")).toBe("gpqadiamond");
  });

  test("strips spaces", () => {
    expect(normalizeBenchmarkName("MMLU Pro")).toBe("mmlupro");
    expect(normalizeBenchmarkName("MATH 500")).toBe("math500");
  });

  test("strips punctuation", () => {
    expect(normalizeBenchmarkName("HumanEval+")).toBe("humaneval");
    expect(normalizeBenchmarkName("AIME (2024)")).toBe("aime2024");
  });

  test("handles unicode by stripping non-alphanumeric", () => {
    // The lab might cite "Tau-bench" with a literal greek tau or smart quote.
    expect(normalizeBenchmarkName("τ-bench")).toBe("bench");
    // While that loses information, it's idempotent — both 'τ-bench' and 'bench'
    // would route to the queue or to 'bench' (if it existed). Borderline cases
    // are intentionally pushed to the queue for human review.
  });

  test("empty input returns empty string", () => {
    expect(normalizeBenchmarkName("")).toBe("");
    expect(normalizeBenchmarkName("   ")).toBe("");
    expect(normalizeBenchmarkName("---")).toBe("");
  });

  test("matches slug variants and name variants to the same key", () => {
    // The benchmarks table indexes by both .slug and .name; both should
    // produce the same normalized key for sane inputs.
    expect(normalizeBenchmarkName("swe-bench-verified")).toBe(
      normalizeBenchmarkName("SWE-bench Verified"),
    );
    expect(normalizeBenchmarkName("humaneval")).toBe(
      normalizeBenchmarkName("HumanEval"),
    );
  });

  test("idempotent — applying twice equals applying once", () => {
    const inputs = [
      "MMLU",
      "SWE-bench Verified",
      "GPQA Diamond",
      "AIME (2024)",
    ];
    for (const s of inputs) {
      const once = normalizeBenchmarkName(s);
      const twice = normalizeBenchmarkName(once);
      expect(twice).toBe(once);
    }
  });
});
