import { describe, it, expect } from "vitest";
import {
  buildUnifiedTimeline,
  type RawMilestone,
  type RawVote,
  type RawAmendment,
  type RawResource,
} from "./timeline-utils";

function makeMilestones(...items: Array<[string, string]>): RawMilestone[] {
  return items.map(([label, value]) => ({ label, value }));
}

function makeResource(
  id: string,
  date: string | null,
  category: "official" | "analysis" | "press" = "press"
): RawResource {
  return {
    id,
    title: `Resource ${id}`,
    url: `https://example.com/${id}`,
    domain: "example.com",
    publishedDate: date,
    category,
  };
}

describe("buildUnifiedTimeline", () => {
  it("creates milestones from customFields sorted oldest-first", () => {
    const milestones = makeMilestones(
      ["Vetoed", "September 29, 2024"],
      ["Introduced", "February 2024"],
      ["Passed Committee", "April 2, 2024"]
    );
    const result = buildUnifiedTimeline(milestones, [], [], []);
    expect(result.milestones).toHaveLength(3);
    expect(result.milestones[0].label).toBe("Introduced");
    expect(result.milestones[1].label).toBe("Passed Committee");
    expect(result.milestones[2].label).toBe("Vetoed");
  });

  it("assigns correct colors to milestones", () => {
    const milestones = makeMilestones(
      ["Introduced", "January 2024"],
      ["Passed Committee", "March 2024"],
      ["Vetoed", "June 2024"]
    );
    const result = buildUnifiedTimeline(milestones, [], [], []);
    expect(result.milestones[0].color).toBe("bg-blue-500");
    expect(result.milestones[1].color).toBe("bg-violet-500");
    expect(result.milestones[2].color).toBe("bg-red-500");
  });

  it("deduplicates votes and milestones by date match", () => {
    const milestones = makeMilestones(
      ["Introduced", "January 2024"],
      ["Passed Senate", "May 21, 2024"]
    );
    const votes: RawVote[] = [
      {
        chamber: "Senate Floor",
        date: "May 21, 2024",
        result: "Passed",
        ayes: 32,
        noes: 1,
        ayesDem: 30,
        ayesRep: 2,
      },
    ];
    const result = buildUnifiedTimeline(milestones, votes, [], []);
    expect(result.milestones).toHaveLength(2);
    // Vote data merged into milestone
    expect(result.milestones[1].vote).toBeDefined();
    expect(result.milestones[1].vote!.ayes).toBe(32);
    expect(result.milestones[1].vote!.noes).toBe(1);
    // No standalone vote child
    const voteChildren = result.milestones[1].children.filter(
      (c) => c.type === "vote"
    );
    expect(voteChildren).toHaveLength(0);
  });

  it("deduplicates votes and milestones by chamber/label similarity", () => {
    const milestones = makeMilestones(
      ["Introduced", "January 2024"],
      ["Passed Assembly", "August 28, 2024"]
    );
    const votes: RawVote[] = [
      {
        chamber: "Assembly Floor",
        date: "August 28, 2024",
        result: "Passed",
        ayes: 48,
        noes: 16,
      },
    ];
    const result = buildUnifiedTimeline(milestones, votes, [], []);
    expect(result.milestones[1].vote).toBeDefined();
    expect(result.milestones[1].vote!.ayes).toBe(48);
  });

  it("keeps unmatched votes as children of the nearest milestone", () => {
    const milestones = makeMilestones(
      ["Introduced", "January 2024"],
      ["Passed Committee", "April 2024"]
    );
    const votes: RawVote[] = [
      {
        chamber: "Subcommittee",
        date: "March 15, 2024",
        result: "Approved",
        ayes: 5,
        noes: 2,
      },
    ];
    const result = buildUnifiedTimeline(milestones, votes, [], []);
    // Should be a child of "Introduced" (nearest preceding milestone)
    const voteChildren = result.milestones[0].children.filter(
      (c) => c.type === "vote"
    );
    expect(voteChildren).toHaveLength(1);
  });

  it("nests amendments under the correct milestone", () => {
    const milestones = makeMilestones(
      ["Introduced", "February 2024"],
      ["Passed Committee", "April 2, 2024"],
      ["Passed Senate", "May 21, 2024"]
    );
    const amendments: RawAmendment[] = [
      { date: "March 20, 2024", description: "Defined thresholds" },
      { date: "April 8, 2024", description: "Refined definitions" },
      { date: "June 20, 2024", description: "Safe harbors" },
    ];
    const result = buildUnifiedTimeline(milestones, [], amendments, []);
    // March 20 → under Introduced (between Feb and Apr 2)
    const introChildren = result.milestones[0].children.filter(
      (c) => c.type === "amendment"
    );
    expect(introChildren).toHaveLength(1);
    // April 8 → under Passed Committee (between Apr 2 and May 21)
    const committeeChildren = result.milestones[1].children.filter(
      (c) => c.type === "amendment"
    );
    expect(committeeChildren).toHaveLength(1);
    // June 20 → under Passed Senate (after May 21, last milestone)
    const senateChildren = result.milestones[2].children.filter(
      (c) => c.type === "amendment"
    );
    expect(senateChildren).toHaveLength(1);
  });

  it("puts resources before first milestone into earlyCoverage", () => {
    const milestones = makeMilestones(["Introduced", "March 2024"]);
    const resources = [makeResource("r1", "2024-01-15")];
    const result = buildUnifiedTimeline(milestones, [], [], resources);
    expect(result.earlyCoverage).toHaveLength(1);
    expect(result.earlyCoverage[0].id).toBe("r1");
  });

  it("nests resources under nearest preceding event (amendment)", () => {
    const milestones = makeMilestones(
      ["Introduced", "February 2024"],
      ["Passed Committee", "August 2024"]
    );
    const amendments: RawAmendment[] = [
      { date: "June 20, 2024", description: "Safe harbors" },
    ];
    const resources = [makeResource("r1", "2024-07-01")];
    const result = buildUnifiedTimeline(milestones, [], amendments, resources);
    // r1 (July 1) should be nested under the June 20 amendment
    const introChildren = result.milestones[0].children;
    const amendment = introChildren.find((c) => c.type === "amendment");
    expect(amendment).toBeDefined();
    if (amendment?.type === "amendment") {
      expect(amendment.resources).toHaveLength(1);
      expect(amendment.resources[0].id).toBe("r1");
    }
  });

  it("nests resources directly under milestone if no preceding child event", () => {
    const milestones = makeMilestones(
      ["Introduced", "February 2024"],
      ["Passed Committee", "August 2024"]
    );
    // Resource after "Introduced" but before any amendments
    const resources = [makeResource("r1", "2024-02-15")];
    const result = buildUnifiedTimeline(milestones, [], [], resources);
    const introChildren = result.milestones[0].children;
    expect(introChildren).toHaveLength(1);
    expect(introChildren[0].type).toBe("resource");
  });

  it("resources after last milestone nest under the last milestone", () => {
    const milestones = makeMilestones(
      ["Introduced", "January 2024"],
      ["Vetoed", "September 29, 2024"]
    );
    const resources = [
      makeResource("r1", "2024-10-01"),
      makeResource("r2", "2024-11-15"),
    ];
    const result = buildUnifiedTimeline(milestones, [], [], resources);
    // Should be under Vetoed, not in earlyCoverage
    expect(result.earlyCoverage).toHaveLength(0);
    const vetoChildren = result.milestones[1].children.filter(
      (c) => c.type === "resource"
    );
    expect(vetoChildren).toHaveLength(2);
  });

  it("puts undated resources in a separate section", () => {
    const milestones = makeMilestones(["Introduced", "January 2024"]);
    const resources = [makeResource("r1", null)];
    const result = buildUnifiedTimeline(milestones, [], [], resources);
    expect(result.undatedResources).toHaveLength(1);
    expect(result.undatedResources[0].id).toBe("r1");
    // Should NOT be in the last milestone's children
    const lastMilestone = result.milestones[result.milestones.length - 1];
    const resourceChildren = lastMilestone.children.filter(
      (c) => c.type === "resource"
    );
    expect(resourceChildren).toHaveLength(0);
  });

  it("handles bills with no milestones", () => {
    const resources = [makeResource("r1", "2024-03-01")];
    const result = buildUnifiedTimeline([], [], [], resources);
    expect(result.milestones).toHaveLength(0);
    // All resources go to earlyCoverage since there are no milestones
    expect(result.earlyCoverage).toHaveLength(1);
  });

  it("handles bills with no amendments or resources", () => {
    const milestones = makeMilestones(
      ["Introduced", "January 2024"],
      ["Enacted", "June 2024"]
    );
    const result = buildUnifiedTimeline(milestones, [], [], []);
    expect(result.milestones).toHaveLength(2);
    expect(result.milestones[0].children).toHaveLength(0);
    expect(result.milestones[1].children).toHaveLength(0);
  });

  it("sorts children within milestones by date", () => {
    const milestones = makeMilestones(
      ["Introduced", "January 2024"],
      ["Vetoed", "December 2024"]
    );
    const amendments: RawAmendment[] = [
      { date: "June 20, 2024", description: "Second" },
      { date: "March 1, 2024", description: "First" },
      { date: "September 1, 2024", description: "Third" },
    ];
    const result = buildUnifiedTimeline(milestones, [], amendments, []);
    const children = result.milestones[0].children;
    expect(children).toHaveLength(3);
    expect(
      (children[0] as Extract<(typeof children)[0], { type: "amendment" }>)
        .description
    ).toBe("First");
    expect(
      (children[1] as Extract<(typeof children)[0], { type: "amendment" }>)
        .description
    ).toBe("Second");
    expect(
      (children[2] as Extract<(typeof children)[0], { type: "amendment" }>)
        .description
    ).toBe("Third");
  });

  it("handles full SB 1047-like scenario", () => {
    const milestones = makeMilestones(
      ["Introduced", "February 2024"],
      ["Passed Committee", "April 2, 2024"],
      ["Passed Senate", "May 21, 2024"],
      ["Passed Assembly", "August 28, 2024"],
      ["Passed Legislature", "August 29, 2024"],
      ["Vetoed", "September 29, 2024"]
    );
    const votes: RawVote[] = [
      { chamber: "Senate Floor", date: "May 21, 2024", result: "Passed", ayes: 32, noes: 1 },
      { chamber: "Assembly Floor", date: "August 28, 2024", result: "Passed", ayes: 48, noes: 16 },
      { chamber: "Senate Concurrence", date: "August 29, 2024", result: "Passed", ayes: 30, noes: 9 },
    ];
    const amendments: RawAmendment[] = [
      { date: "March 20, 2024", description: "Defined thresholds" },
      { date: "April 8, 2024", description: "Refined definitions" },
      { date: "August 19, 2024", description: "Major overhaul", author: "Senator Wiener" },
    ];
    const resources = [
      makeResource("r1", "2024-02-01", "analysis"),
      makeResource("r2", "2024-07-01", "analysis"),
      makeResource("r3", "2024-08-22", "press"),
      makeResource("r4", "2024-09-29", "press"),
    ];

    const result = buildUnifiedTimeline(milestones, votes, amendments, resources);

    // Should have 6 milestones
    expect(result.milestones).toHaveLength(6);
    // Senate Floor vote merged with Passed Senate
    expect(result.milestones[2].vote).toBeDefined();
    expect(result.milestones[2].vote!.ayes).toBe(32);
    // Assembly Floor vote merged with Passed Assembly
    expect(result.milestones[3].vote).toBeDefined();
    expect(result.milestones[3].vote!.ayes).toBe(48);
    // Senate Concurrence vote merged with Passed Legislature
    expect(result.milestones[4].vote).toBeDefined();
    expect(result.milestones[4].vote!.ayes).toBe(30);
    // Resource r1 under Introduced (Feb)
    const introResources = result.milestones[0].children.filter(c => c.type === "resource");
    expect(introResources).toHaveLength(1);
    // Resource r4 under Vetoed
    const vetoResources = result.milestones[5].children.filter(c => c.type === "resource");
    expect(vetoResources).toHaveLength(1);
  });
});
