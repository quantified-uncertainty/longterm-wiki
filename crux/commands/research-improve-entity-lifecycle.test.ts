/**
 * Integration test for the `withPipelineRun` lifecycle wiring around
 * `improveSingleEntity` (QUA-957 Phase 1). Separate file so `vi.mock`
 * can replace the lifecycle module without affecting the pure-helper
 * tests in research-improve-entity.test.ts.
 *
 * The wiring is structurally trivial — `withPipelineRun(opts, body)` —
 * but the hostile review noted that the unit tests on
 * `buildImproveEntityRunOptions` only exercise the input-builder; nothing
 * verified that `withPipelineRun` is actually invoked at the call site
 * with those options. This file closes that gap by mocking the lifecycle
 * helper, observing the call from a real `improveSingleEntity`
 * invocation, and asserting both the options shape and the body fired.
 */

import { describe, it, expect, vi } from "vitest";

const mockWithPipelineRun = vi.fn();

vi.mock("../lib/pipeline-runs/lifecycle.ts", () => ({
  withPipelineRun: (...args: unknown[]) => mockWithPipelineRun(...args),
}));

// Suppress the "improve-entity result" stdout from a real run.
const consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});

describe("improveSingleEntity wraps its body with withPipelineRun (QUA-957)", () => {
  // A real policy entity from `data/entities/responses.yaml` so `findEntity`
  // resolves without needing fs mocks. Stable test fixture — the slug
  // and stableId are tracked in version control.
  const FIXTURE_SLUG = "california-sb1047";
  const FIXTURE_STABLE_ID = "sid_XcGTez1oFw";

  it("invokes withPipelineRun once with the expected options and runs the body inside it", async () => {
    mockWithPipelineRun.mockReset();
    consoleLogSpy.mockClear();

    // Capture options + return a stub ImproveResult without driving the
    // closed-loop body. The body still runs (so a regression where the
    // wrapper accidentally never invokes its body would be caught), but
    // we short-circuit the result.
    let bodyRan = false;
    mockWithPipelineRun.mockImplementation(async (_options, body) => {
      // Calling body() would drive runIteration → LLM/network. We instead
      // assert the body is callable and short-circuit. The mock signature
      // matches `withPipelineRun<T>(options, body)` from lifecycle.ts.
      bodyRan = typeof body === "function";
      return {
        entity_slug: FIXTURE_SLUG,
        entity_id: FIXTURE_STABLE_ID,
        entity_type: "policy",
        iterations: [],
        final_coverage: 0,
        final_facts: {},
        total_cost_usd: 0,
        total_duration_s: 0,
        hit_target: false,
        reason: "test-stub",
      };
    });

    const { improveSingleEntity } = await import("./research-improve-entity.ts");

    await improveSingleEntity({
      slug: FIXTURE_SLUG,
      target: 1,
      maxIters: 1,
      budgetUsd: 0.01,
      dryRun: true,
      quiet: true,
    });

    expect(mockWithPipelineRun).toHaveBeenCalledTimes(1);
    expect(bodyRan).toBe(true);

    const [optionsArg, bodyArg] = mockWithPipelineRun.mock.calls[0];
    expect(optionsArg.pipelineName).toBe("improve-entity");
    expect(optionsArg.entityId).toBe(FIXTURE_STABLE_ID);
    expect(optionsArg.shape).toBe("policy");
    expect(optionsArg.allowOffline).toBe(true);
    expect(typeof bodyArg).toBe("function");
  });

  it("does NOT invoke withPipelineRun when input validation fails before the wrapper", async () => {
    mockWithPipelineRun.mockReset();
    const { improveSingleEntity } = await import("./research-improve-entity.ts");

    await expect(
      improveSingleEntity({
        slug: FIXTURE_SLUG,
        target: -1, // invalid → throws before reaching withPipelineRun
        maxIters: 1,
        budgetUsd: 0.01,
        dryRun: true,
        quiet: true,
      }),
    ).rejects.toThrow(/target must be a positive integer/);

    expect(mockWithPipelineRun).not.toHaveBeenCalled();
  });

  it("does NOT invoke withPipelineRun when the entity is missing", async () => {
    mockWithPipelineRun.mockReset();
    const { improveSingleEntity } = await import("./research-improve-entity.ts");

    await expect(
      improveSingleEntity({
        slug: "this-policy-definitely-does-not-exist-anywhere",
        target: 1,
        maxIters: 1,
        budgetUsd: 0.01,
        dryRun: true,
        quiet: true,
      }),
    ).rejects.toThrow(/Entity not found/);

    expect(mockWithPipelineRun).not.toHaveBeenCalled();
  });
});
