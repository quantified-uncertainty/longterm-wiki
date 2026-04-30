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

  it("treats an entity with empty/undefined title as 'resolves' (existence-based, not truthy-based)", () => {
    // Regression check: the resolved-title skip uses Map.has(slug), not
    // truthy-checking the title string. An entity with title="" is still a
    // real entity that the rendering layer can substitute for; flagging it
    // would re-introduce the QUA-899 false positive.
    const { results } = runValidation({
      typedEntities: [
        {
          id: "stub-project",
          entityType: "project",
          title: "Stub Project",
          description: "A project pointing at an entity with no title yet.",
          organization: "placeholder-future-org",
        },
        {
          id: "placeholder-future-org",
          entityType: "organization",
          title: "",
          description: "Stub org awaiting enrichment.",
          orgType: "generic",
        },
      ],
      filterType: "project",
    });

    const projectIssues = results.find((r) => r.entityType === "project")?.issues ?? [];
    const slugLeaks = projectIssues.filter((i) => i.issueType === "slug-in-display");
    expect(slugLeaks).toEqual([]);
  });
});

describe("validate-directory-pages: other issue types", () => {
  it("flags an entity whose title looks like an unresolved slug", () => {
    const { results } = runValidation({
      typedEntities: [
        {
          id: "stuck-slug",
          entityType: "project",
          title: "stuck-slug-title-here",
          description: "Title was never resolved from slug.",
        },
      ],
      filterType: "project",
    });

    const issues = results.find((r) => r.entityType === "project")?.issues ?? [];
    expect(issues.filter((i) => i.issueType === "title-is-slug")).toHaveLength(1);
  });

  it("flags entities missing required key fields", () => {
    const { results } = runValidation({
      typedEntities: [
        {
          id: "minimal-org",
          entityType: "organization",
          title: "Minimal Org",
          // missing description and orgType
        },
      ],
      filterType: "organization",
    });

    const issues = results.find((r) => r.entityType === "organization")?.issues ?? [];
    const missing = issues.filter((i) => i.issueType === "missing-field");
    expect(missing.map((i) => i.field).sort()).toEqual(["description", "orgType"]);
  });

  it("flags non-standard date formats", () => {
    const { results } = runValidation({
      typedEntities: [
        {
          id: "weird-event",
          entityType: "event",
          title: "Weird Event",
          description: "An event with a malformed startDate.",
          startDate: "March 2026",
        },
      ],
      filterType: "event",
    });

    const issues = results.find((r) => r.entityType === "event")?.issues ?? [];
    expect(issues.filter((i) => i.issueType === "bad-date-format")).toHaveLength(1);
  });
});
