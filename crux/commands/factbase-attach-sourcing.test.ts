/**
 * Integration tests for `crux fb attach-sourcing` (QUA-850 Phase A).
 *
 * These tests stand up a tiny temp KB directory and stub `fetchInlineSourcing`
 * so the helper exercises its real planner + writer code without hitting the
 * network. Coverage:
 *   - Dry-run does not modify YAML.
 *   - --apply writes a valid sourcing block onto the matching fact.
 *   - A second --apply on identical state is a no-op (idempotency — the
 *     QUA-850 acceptance criterion).
 *   - Verdicts in PG with no live YAML fact are reported as orphans.
 *   - --fact filter narrows to a single fact.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, writeFile, mkdir, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

// Hoisted mocks — defined before the module-under-test imports.
const { mockFetchInlineSourcing, mockBuildEntityMap } = vi.hoisted(() => ({
  mockFetchInlineSourcing: vi.fn(),
  mockBuildEntityMap: vi.fn(),
}));

vi.mock("../lib/wiki-server/inline-sourcing.ts", () => ({
  fetchInlineSourcing: mockFetchInlineSourcing,
}));

// Stub buildTableBaseEntityMap so the loader doesn't try to read the
// real `data/entities/*.yaml` set during the test.
vi.mock("../lib/factbase-loader.ts", async () => {
  const actual: typeof import("../lib/factbase-loader.ts") = await vi.importActual(
    "../lib/factbase-loader.ts",
  );
  return {
    ...actual,
    buildTableBaseEntityMap: mockBuildEntityMap,
  };
});

const { attachSourcingCommand } = await import("./factbase-attach-sourcing.ts");

// ── Test fixtures ────────────────────────────────────────────────────

async function createKBDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "fb-attach-test-"));

  await writeFile(
    join(dataDir, "properties.yaml"),
    `properties:
  revenue:
    name: Revenue
    dataType: number
    unit: USD
    temporal: true
`,
  );
  await mkdir(join(dataDir, "schemas"));
  await writeFile(
    join(dataDir, "schemas", "organization.yaml"),
    `type: organization
name: Organization
required: []
recommended: []
`,
  );
  await mkdir(join(dataDir, "fb-entities"));
  await writeFile(
    join(dataDir, "fb-entities", "anthropic.yaml"),
    `thing:
  id: anthropic
  stableId: mK9pX3rQ7n
  type: organization
  name: Anthropic

facts:
  - id: f_revwithsrc
    property: revenue
    value: 1000000000
    asOf: "2024"
    source: "https://anthropic.com/about"
  - id: f_revnosrc
    property: revenue
    value: 2000000000
    asOf: "2025"
`,
  );
  return dataDir;
}

// ── Tests ────────────────────────────────────────────────────────────

describe("crux fb attach-sourcing (QUA-850)", () => {
  let dataDir: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    dataDir = await createKBDir();
    mockBuildEntityMap.mockReturnValue(new Map());
    // Default: no verdicts unless overridden by the test.
    mockFetchInlineSourcing.mockResolvedValue(new Map());
  });

  afterEach(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("dry-run reports planned writes without mutating YAML", async () => {
    mockFetchInlineSourcing.mockResolvedValue(
      new Map([
        [
          "f_revwithsrc",
          { verdict: "confirmed", confidence: 0.9, evidence: "Annual report." },
        ],
      ]),
    );

    const before = await readFile(join(dataDir, "fb-entities", "anthropic.yaml"), "utf-8");
    const result = await attachSourcingCommand([], { dataDir });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("dry-run");
    expect(result.output).toContain("would write:    1");

    // YAML untouched.
    const after = await readFile(join(dataDir, "fb-entities", "anthropic.yaml"), "utf-8");
    expect(after).toBe(before);
    expect(after).not.toContain("sourcing:");
  });

  it("--apply writes the sourcing block to YAML", async () => {
    mockFetchInlineSourcing.mockResolvedValue(
      new Map([
        [
          "f_revwithsrc",
          {
            verdict: "confirmed",
            confidence: 0.9,
            evidence: "Annual report.",
            checkedAt: "2026-04-29T00:00:00.000Z",
          },
        ],
      ]),
    );

    const result = await attachSourcingCommand([], { apply: true, dataDir });

    expect(result.exitCode).toBe(0);
    expect(result.output).toContain("apply");
    expect(result.output).toContain("wrote:    1");

    const after = await readFile(join(dataDir, "fb-entities", "anthropic.yaml"), "utf-8");
    expect(after).toMatch(/id: f_revwithsrc/);
    expect(after).toMatch(/sourcing:/);
    expect(after).toMatch(/verdict: confirmed/);
    expect(after).toMatch(/confidence: 0\.9/);
    expect(after).toContain("Annual report.");
    expect(after).toContain("2026-04-29T00:00:00.000Z");
  });

  it("a second --apply on identical state is a no-op (idempotent)", async () => {
    const verdict = {
      verdict: "confirmed" as const,
      confidence: 0.9,
      evidence: "Annual report.",
    };
    mockFetchInlineSourcing.mockResolvedValue(new Map([["f_revwithsrc", verdict]]));

    // First apply.
    const first = await attachSourcingCommand([], { apply: true, dataDir });
    expect(first.output).toContain("wrote:    1");
    const yamlAfterFirst = await readFile(
      join(dataDir, "fb-entities", "anthropic.yaml"),
      "utf-8",
    );

    // Second apply with the same PG state. Nothing should change.
    const second = await attachSourcingCommand([], { apply: true, dataDir });
    expect(second.exitCode).toBe(0);
    expect(second.output).toContain("wrote:    0");
    const yamlAfterSecond = await readFile(
      join(dataDir, "fb-entities", "anthropic.yaml"),
      "utf-8",
    );
    expect(yamlAfterSecond).toBe(yamlAfterFirst);
  });

  it("counts orphan verdicts (PG row with no live YAML fact)", async () => {
    mockFetchInlineSourcing.mockResolvedValue(
      new Map([
        ["f_revwithsrc", { verdict: "confirmed" as const }],
        ["f_does_not_exist", { verdict: "partial" as const }],
        ["f_also_gone", { verdict: "outdated" as const }],
      ]),
    );

    const result = await attachSourcingCommand([], { dataDir });
    expect(result.output).toContain("Orphan verdicts:   2");
  });

  it("--fact narrows to a single fact and skips the rest", async () => {
    mockFetchInlineSourcing.mockResolvedValue(
      new Map([
        ["f_revwithsrc", { verdict: "confirmed" as const }],
        ["f_revnosrc", { verdict: "partial" as const }],
      ]),
    );

    const result = await attachSourcingCommand([], { apply: true, fact: "f_revwithsrc", dataDir });
    expect(result.output).toContain("wrote:    1");

    const after = await readFile(join(dataDir, "fb-entities", "anthropic.yaml"), "utf-8");
    // Block landed on f_revwithsrc.
    expect(after).toMatch(/id: f_revwithsrc[\s\S]*sourcing:[\s\S]*verdict: confirmed/);
    // f_revnosrc was filtered out — no sourcing block on that fact.
    const revnosrcStart = after.indexOf("f_revnosrc");
    expect(revnosrcStart).toBeGreaterThan(-1);
    expect(after.slice(revnosrcStart)).not.toMatch(/sourcing:/);
  });

  it("emits machine-readable JSON when --json is set", async () => {
    mockFetchInlineSourcing.mockResolvedValue(
      new Map([["f_revwithsrc", { verdict: "confirmed" as const }]]),
    );

    const result = await attachSourcingCommand([], { json: true, dataDir });
    expect(result.exitCode).toBe(0);
    const parsed = JSON.parse(result.output) as {
      summary: {
        applied: boolean;
        toWrite: number;
        unchanged: number;
        factsMatched: number;
      };
    };
    expect(parsed.summary.applied).toBe(false);
    expect(parsed.summary.toWrite).toBe(1);
    expect(parsed.summary.factsMatched).toBe(1);
  });
});
