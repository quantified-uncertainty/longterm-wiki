import { describe, it, expect } from "vitest";
import { SyncPageSchema, SyncBatchSchema } from "../routes/pages.js";

/**
 * This fixture mirrors the JSON body hardcoded in
 * .github/workflows/wiki-server-docker.yml (Post-deploy smoke test step).
 *
 * If this test fails, update BOTH this fixture AND the workflow YAML.
 */
const SMOKE_TEST_BODY = {
  pages: [
    {
      id: "__smoke-test__",
      numericId: null,
      title: "Smoke Test",
      description: null,
      llmSummary: null,
      category: null,
      subcategory: null,
      entityType: null,
      tags: null,
      quality: null,
      readerImportance: null,
      hallucinationRiskLevel: null,
      hallucinationRiskScore: null,
      contentPlaintext: null,
      wordCount: null,
      lastUpdated: null,
      contentFormat: null,
    },
  ],
};

describe("smoke test fixture", () => {
  it("validates against SyncBatchSchema", () => {
    const result = SyncBatchSchema.safeParse(SMOKE_TEST_BODY);
    expect(result.success).toBe(true);
  });

  it("includes every field from SyncPageSchema", () => {
    const schemaKeys = Object.keys(SyncPageSchema.shape).sort();
    const fixtureKeys = Object.keys(SMOKE_TEST_BODY.pages[0]).sort();
    expect(fixtureKeys).toEqual(schemaKeys);
  });
});
