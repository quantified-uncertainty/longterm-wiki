import { describe, it, expect } from "vitest";
import { runValidation } from "../validate-directory-pages.ts";

describe("validate-directory-pages: slug-in-display", () => {
  it("does not flag a slug-shaped value when the slug resolves to a known entity", () => {
    // Reproduces QUA-899: project entities whose `organization` field stored a
    // 3+ part kebab-case slug were flagged as slug-leaks even though the
    // rendering layer (apps/web/src/app/projects/page.tsx) calls
    // getTypedEntityById(slug) and renders entity.title. As long as the slug
    // resolves, no slug ever reaches the user.
    const { results } = runValidation({
      typedEntities: [
        {
          id: "talk-to-the-city",
          entityType: "project",
          title: "Talk to the City",
          description: "An open-source LLM tool for scaling deliberation.",
          organization: "ai-objectives-institute",
        },
        {
          id: "ai-objectives-institute",
          entityType: "organization",
          title: "AI Objectives Institute",
          description: "Research org working on AI alignment via mechanism design.",
          orgType: "generic",
        },
      ],
      filterType: "project",
    });

    const projectIssues = results.find((r) => r.entityType === "project")?.issues ?? [];
    const slugLeaks = projectIssues.filter((i) => i.issueType === "slug-in-display");
    expect(slugLeaks).toEqual([]);
  });

  it("flags a slug-shaped value when the slug does NOT resolve to any entity", () => {
    // The genuine bug pattern: project references an org slug that isn't in
    // typedEntities, so the rendering fallback (orgName = orgId) leaks the
    // raw slug to the user.
    const { results } = runValidation({
      typedEntities: [
        {
          id: "ghost-project",
          entityType: "project",
          title: "Ghost Project",
          description: "References a missing org.",
          organization: "nonexistent-missing-org",
        },
      ],
      filterType: "project",
    });

    const projectIssues = results.find((r) => r.entityType === "project")?.issues ?? [];
    const slugLeaks = projectIssues.filter((i) => i.issueType === "slug-in-display");
    expect(slugLeaks).toHaveLength(1);
    expect(slugLeaks[0].field).toBe("organization");
    expect(slugLeaks[0].value).toBe("nonexistent-missing-org");
    expect(slugLeaks[0].detail).toContain("no matching entity");
  });

  it("ignores 1-2 part slug-shaped values (looksLikeSlug requires 3+ parts)", () => {
    // Single- or double-word values like "deepmind" or "ai-democracy" are
    // legitimate display strings and never trigger the heuristic.
    const { results } = runValidation({
      typedEntities: [
        {
          id: "habermas-machine",
          entityType: "project",
          title: "Habermas Machine",
          description: "A deliberation tool.",
          organization: "deepmind",
        },
      ],
      filterType: "project",
    });

    const projectIssues = results.find((r) => r.entityType === "project")?.issues ?? [];
    const slugLeaks = projectIssues.filter((i) => i.issueType === "slug-in-display");
    expect(slugLeaks).toEqual([]);
  });
});
