/**
 * Tests for the optional `sourcing:` block on FactBase facts (QUA-850 Phase A).
 *
 * The loader must:
 *   - Pass `sourcing` through unchanged when present in YAML.
 *   - Not invent a sourcing block when absent (backwards-compatible).
 *   - Not crash if YAML has unknown sub-keys inside `sourcing` — the wiki-
 *     server's Zod schema is the validation boundary, not the loader.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadKB } from "../src/loader";

async function createKBDir(): Promise<string> {
  const dataDir = await mkdtemp(join(tmpdir(), "fb-sourcing-test-"));
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
  return dataDir;
}

describe("FactBase loader — sourcing pass-through (QUA-850)", () => {
  let dataDir: string;

  beforeAll(async () => {
    dataDir = await createKBDir();
    await writeFile(
      join(dataDir, "fb-entities", "anthropic.yaml"),
      `thing:
  id: anthropic
  stableId: mK9pX3rQ7n
  type: organization
  name: Anthropic

facts:
  # Fact with full sourcing block
  - id: f_revwithsrc
    property: revenue
    value: 1000000000
    asOf: "2024"
    source: "https://example.com/anthropic-revenue"
    sourcing:
      verdict: confirmed
      evidence: "Annual report states $1B revenue."
      confidence: 0.92
      checkedAt: "2026-04-01T00:00:00.000Z"
      checkedBy: "claude-haiku-4-5-20251001"
  # Fact without sourcing block
  - id: f_revnosrc
    property: revenue
    value: 2000000000
    asOf: "2025"
`,
    );
  });

  afterAll(async () => {
    await rm(dataDir, { recursive: true, force: true });
  });

  it("passes the sourcing block through to the parsed Fact", async () => {
    const { graph } = await loadKB(dataDir);
    const facts = graph.getFacts("mK9pX3rQ7n");
    const verified = facts.find((f) => f.id === "f_revwithsrc");
    expect(verified).toBeDefined();
    expect(verified!.sourcing).toEqual({
      verdict: "confirmed",
      evidence: "Annual report states $1B revenue.",
      confidence: 0.92,
      checkedAt: "2026-04-01T00:00:00.000Z",
      checkedBy: "claude-haiku-4-5-20251001",
    });
  });

  it("leaves sourcing undefined on facts without the block (no fabrication)", async () => {
    const { graph } = await loadKB(dataDir);
    const facts = graph.getFacts("mK9pX3rQ7n");
    const unverified = facts.find((f) => f.id === "f_revnosrc");
    expect(unverified).toBeDefined();
    expect(unverified!.sourcing).toBeUndefined();
  });
});
