import { describe, it, expect } from "vitest";
import { parseManifundProjects, type ManifundProject } from "../sources/manifund.ts";
import type { EntityMatcher } from "../types.ts";

function makeMockMatcher(): EntityMatcher {
  const nameMap = new Map<string, { stableId: string; slug: string; name: string }>();
  nameMap.set("alice smith", { stableId: "alice123", slug: "alice-smith", name: "Alice Smith" });
  return {
    allNames: nameMap,
    match: (name: string) => nameMap.get(name.toLowerCase().trim()) || null,
  };
}

function makeProject(overrides: Partial<ManifundProject> = {}): ManifundProject {
  return {
    title: "Test Project",
    id: "proj-1",
    created_at: "2024-03-15T12:00:00.000Z",
    creator: "user-1",
    slug: "test-project",
    blurb: "A test project",
    description: "Full description",
    stage: "active",
    funding_goal: 50000,
    min_funding: 10000,
    type: "grant",
    profiles: { username: "testuser", full_name: "Test User" },
    txns: [
      { amount: 25000, token: "USD" },
      { amount: 5000, token: "USD" },
    ],
    bids: [],
    causes: [{ title: "AI Safety", slug: "ai-safety" }],
    ...overrides,
  };
}

describe("parseManifundProjects", () => {
  const matcher = makeMockMatcher();

  it("calculates total funding from USD txns", () => {
    const project = makeProject({
      txns: [
        { amount: 10000, token: "USD" },
        { amount: 5000, token: "USD" },
        { amount: 100, token: "M$" }, // non-USD, should be ignored
      ],
    });

    const grants = parseManifundProjects([project], matcher);
    expect(grants).toHaveLength(1);
    expect(grants[0].amount).toBe(15000);
  });

  it("skips unfunded projects", () => {
    const unfunded = makeProject({ txns: [] });
    const negativeFunding = makeProject({
      txns: [{ amount: -500, token: "USD" }],
    });
    const zeroFunding = makeProject({
      txns: [{ amount: 0, token: "USD" }],
    });

    const grants = parseManifundProjects([unfunded, negativeFunding, zeroFunding], matcher);
    expect(grants).toHaveLength(0);
  });

  it("uses full_name for granteeName", () => {
    const project = makeProject({
      profiles: { username: "alice123", full_name: "Alice Smith" },
    });
    const grants = parseManifundProjects([project], matcher);
    expect(grants[0].granteeName).toBe("Alice Smith");
  });

  it("falls back to username when no full_name", () => {
    const project = makeProject({
      profiles: { username: "bob42", full_name: "" },
    });
    const grants = parseManifundProjects([project], matcher);
    // Empty string is falsy, falls through to username
    expect(grants[0].granteeName).toBe("bob42");
  });

  it("extracts ISO date from created_at", () => {
    const project = makeProject({
      created_at: "2024-06-20T08:30:00.000Z",
    });
    const grants = parseManifundProjects([project], matcher);
    expect(grants[0].date).toBe("2024-06-20");
  });

  it("sets per-project sourceUrl", () => {
    const project = makeProject({ slug: "my-cool-project" });
    const grants = parseManifundProjects([project], matcher);
    expect(grants[0].sourceUrl).toBe("https://manifund.org/projects/my-cool-project");
  });

  it("joins causes into focusArea", () => {
    const project = makeProject({
      causes: [
        { title: "AI Safety", slug: "ai-safety" },
        { title: "Biosecurity", slug: "biosecurity" },
      ],
    });
    const grants = parseManifundProjects([project], matcher);
    expect(grants[0].focusArea).toBe("AI Safety, Biosecurity");
  });

  it("matches grantee via entity matcher", () => {
    const project = makeProject({
      profiles: { username: "alice", full_name: "Alice Smith" },
    });
    const grants = parseManifundProjects([project], matcher);
    expect(grants[0].granteeId).toBe("alice123");
  });

  it("sums multiple funded projects correctly", () => {
    const projects = [
      makeProject({
        id: "p1",
        slug: "project-1",
        txns: [{ amount: 10000, token: "USD" }],
      }),
      makeProject({
        id: "p2",
        slug: "project-2",
        txns: [{ amount: 20000, token: "USD" }],
      }),
    ];
    const grants = parseManifundProjects(projects, matcher);
    expect(grants).toHaveLength(2);
    const total = grants.reduce((s, g) => s + (g.amount || 0), 0);
    expect(total).toBe(30000);
  });

  it("uses 'Unknown' when profiles is null", () => {
    const project = makeProject({
      profiles: null,
    });
    const grants = parseManifundProjects([project], matcher);
    expect(grants[0].granteeName).toBe("Unknown");
  });

  it("falls back to username when full_name is missing (null-like)", () => {
    const project = makeProject({
      profiles: { username: "jdoe", full_name: "" },
    });
    const grants = parseManifundProjects([project], matcher);
    expect(grants[0].granteeName).toBe("jdoe");
  });

  it("sets focusArea to null when no causes", () => {
    const project = makeProject({
      causes: [],
    });
    const grants = parseManifundProjects([project], matcher);
    expect(grants[0].focusArea).toBeNull();
  });

  it("joins multiple causes with comma separator", () => {
    const project = makeProject({
      causes: [
        { title: "AI Safety", slug: "ai-safety" },
        { title: "Biosecurity", slug: "biosecurity" },
        { title: "Nuclear Risk", slug: "nuclear-risk" },
      ],
    });
    const grants = parseManifundProjects([project], matcher);
    expect(grants[0].focusArea).toBe("AI Safety, Biosecurity, Nuclear Risk");
  });
});
