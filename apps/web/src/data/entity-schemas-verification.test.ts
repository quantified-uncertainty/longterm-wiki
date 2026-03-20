import { describe, it, expect } from "vitest";
import { TypedEntitySchema } from "@/data/entity-schemas";

/**
 * Tests for the PolicyStakeholder verification schema extension.
 * Validates that the new verification field is properly optional and
 * correctly validates when present.
 */

function makePolicyEntity(stakeholderOverrides: Record<string, unknown> = {}) {
  return {
    id: "test-policy",
    title: "Test Policy Act",
    entityType: "policy" as const,
    stakeholders: [
      {
        name: "Test Org",
        position: "support",
        reason: "Test reason",
        ...stakeholderOverrides,
      },
    ],
  };
}

describe("PolicyStakeholder verification schema", () => {
  it("accepts stakeholders without verification (backward compatible)", () => {
    const result = TypedEntitySchema.safeParse(makePolicyEntity());
    expect(result.success).toBe(true);
  });

  it("accepts stakeholders with undefined verification", () => {
    const result = TypedEntitySchema.safeParse(
      makePolicyEntity({ verification: undefined })
    );
    expect(result.success).toBe(true);
  });

  it("accepts stakeholders with empty verification object", () => {
    const result = TypedEntitySchema.safeParse(
      makePolicyEntity({ verification: {} })
    );
    expect(result.success).toBe(true);
  });

  it("accepts stakeholders with full verification data", () => {
    const result = TypedEntitySchema.safeParse(
      makePolicyEntity({
        verification: {
          status: "verified",
          verifiedDate: "2026-03-15",
          notes: "Confirmed via official testimony.",
          evidence: [
            {
              type: "primary-source",
              url: "https://example.com/testimony.pdf",
              description: "Written testimony submitted to committee",
              date: "2025-09-01",
            },
            {
              type: "news-report",
              description: "Reported by AP News",
            },
          ],
        },
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const entity = result.data;
      if (entity.entityType === "policy") {
        const stakeholder = entity.stakeholders[0];
        expect(stakeholder.verification?.status).toBe("verified");
        expect(stakeholder.verification?.evidence).toHaveLength(2);
        expect(stakeholder.verification?.evidence?.[0].type).toBe(
          "primary-source"
        );
      }
    }
  });

  it("accepts all valid verification statuses", () => {
    for (const status of [
      "verified",
      "partially-verified",
      "unverified",
      "disputed",
    ]) {
      const result = TypedEntitySchema.safeParse(
        makePolicyEntity({
          verification: { status },
        })
      );
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid verification status", () => {
    const result = TypedEntitySchema.safeParse(
      makePolicyEntity({
        verification: { status: "unknown-status" },
      })
    );
    expect(result.success).toBe(false);
  });

  it("accepts all valid evidence types", () => {
    for (const type of [
      "primary-source",
      "news-report",
      "social-media",
      "official-statement",
      "inference",
    ]) {
      const result = TypedEntitySchema.safeParse(
        makePolicyEntity({
          verification: {
            status: "verified",
            evidence: [{ type, description: "Test evidence" }],
          },
        })
      );
      expect(result.success).toBe(true);
    }
  });

  it("rejects invalid evidence type", () => {
    const result = TypedEntitySchema.safeParse(
      makePolicyEntity({
        verification: {
          status: "verified",
          evidence: [{ type: "blog-post", description: "Some blog" }],
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("rejects evidence without required description field", () => {
    const result = TypedEntitySchema.safeParse(
      makePolicyEntity({
        verification: {
          status: "verified",
          evidence: [{ type: "primary-source", url: "https://example.com" }],
        },
      })
    );
    expect(result.success).toBe(false);
  });

  it("accepts verification with only status (minimal)", () => {
    const result = TypedEntitySchema.safeParse(
      makePolicyEntity({
        verification: { status: "unverified" },
      })
    );
    expect(result.success).toBe(true);
  });

  it("accepts verification with notes but no evidence", () => {
    const result = TypedEntitySchema.safeParse(
      makePolicyEntity({
        verification: {
          status: "partially-verified",
          notes: "Position inferred from public statements",
        },
      })
    );
    expect(result.success).toBe(true);
  });

  it("accepts evidence without optional url and date", () => {
    const result = TypedEntitySchema.safeParse(
      makePolicyEntity({
        verification: {
          status: "verified",
          evidence: [
            {
              type: "inference",
              description: "Based on organizational mission statement",
            },
          ],
        },
      })
    );
    expect(result.success).toBe(true);
    if (result.success) {
      const entity = result.data;
      if (entity.entityType === "policy") {
        const ev = entity.stakeholders[0].verification?.evidence?.[0];
        expect(ev?.url).toBeUndefined();
        expect(ev?.date).toBeUndefined();
      }
    }
  });
});
