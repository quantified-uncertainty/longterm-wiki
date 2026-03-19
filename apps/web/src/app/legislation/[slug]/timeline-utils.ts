import { parseDisplayDateToISO } from "./date-utils";

// ── Types ───────────────────────────────────────────────────────────────

export interface TimelineMilestone {
  sortDate: string;
  displayDate: string;
  label: string;
  color: string; // Tailwind dot color class
  vote?: {
    chamber: string;
    result: string;
    ayes?: number;
    noes?: number;
    ayesDem?: number;
    ayesRep?: number;
    noesDem?: number;
    noesRep?: number;
  };
  children: TimelineChild[];
}

export type TimelineChild =
  | {
      type: "amendment";
      sortDate: string;
      date: string;
      description: string;
      url?: string;
      author?: string;
    }
  | {
      type: "vote";
      sortDate: string;
      chamber: string;
      date: string;
      result: string;
      ayes?: number;
      noes?: number;
      ayesDem?: number;
      ayesRep?: number;
      noesDem?: number;
      noesRep?: number;
    }
  | TimelineResourceChild;

export interface TimelineResourceChild {
  type: "resource";
  id: string;
  title: string;
  url: string;
  domain: string | null;
  publishedDate: string;
  sortDate: string;
  category: "official" | "analysis" | "press";
}

export interface UnifiedTimeline {
  earlyCoverage: TimelineResourceChild[];
  milestones: TimelineMilestone[];
  undatedResources: TimelineResourceChild[];
}

// ── Input types (from the page data) ────────────────────────────────────

export interface RawMilestone {
  label: string;
  value: string; // display date
}

export interface RawVote {
  chamber: string;
  date?: string;
  result: string;
  ayes?: number;
  noes?: number;
  ayesDem?: number;
  ayesRep?: number;
  noesDem?: number;
  noesRep?: number;
}

export interface RawAmendment {
  date: string;
  description: string;
  author?: string;
  url?: string;
}

export interface RawResource {
  id: string;
  title: string;
  url: string;
  domain: string | null;
  publishedDate: string | null;
  category: "official" | "analysis" | "press";
}

// ── Color mapping ───────────────────────────────────────────────────────

function getMilestoneColor(label: string): string {
  if (label === "Introduced") return "bg-blue-500";
  if (
    label === "Signed" ||
    label === "Enacted" ||
    label === "Effective" ||
    label === "In Force"
  )
    return "bg-green-500";
  if (label === "Vetoed") return "bg-red-500";
  return "bg-violet-500";
}

// ── Vote/milestone deduplication ────────────────────────────────────────

const CHAMBER_TO_MILESTONE: Record<string, string[]> = {
  "senate floor": ["passed senate"],
  "assembly floor": ["passed assembly"],
  "house floor": ["passed house"],
  "senate concurrence": ["passed legislature"],
  "house concurrence": ["passed legislature"],
  "assembly concurrence": ["passed legislature"],
};

function voteLabelMatch(voteChamber: string, milestoneLabel: string): boolean {
  const chamberKey = voteChamber.toLowerCase();
  const labelKey = milestoneLabel.toLowerCase();
  const matchLabels = CHAMBER_TO_MILESTONE[chamberKey];
  return matchLabels !== undefined && matchLabels.includes(labelKey);
}

function voteDateMatch(voteDate: string, milestoneDate: string): boolean {
  const vd = new Date(voteDate).getTime();
  const md = new Date(milestoneDate).getTime();
  return !isNaN(vd) && !isNaN(md) && Math.abs(vd - md) <= 86400000;
}

// ── Main merge algorithm ────────────────────────────────────────────────

export function buildUnifiedTimeline(
  rawMilestones: RawMilestone[],
  rawVotes: RawVote[],
  rawAmendments: RawAmendment[],
  rawResources: RawResource[]
): UnifiedTimeline {
  // Step 1: Parse milestones and sort oldest-first
  const milestones: TimelineMilestone[] = rawMilestones
    .map((m) => {
      const sortDate = parseDisplayDateToISO(m.value);
      if (!sortDate) return null;
      return {
        sortDate,
        displayDate: m.value,
        label: m.label,
        color: getMilestoneColor(m.label),
        children: [] as TimelineChild[],
      };
    })
    .filter((m): m is TimelineMilestone => m !== null)
    .sort((a, b) => a.sortDate.localeCompare(b.sortDate));

  // Step 2: Match votes to milestones (dedup), collect unmatched votes.
  // Two-pass: label-based matches first (stronger signal), then date-based.
  const matchedVoteIndices = new Set<number>();
  const claimedMilestoneIndices = new Set<number>();

  function assignVoteToMilestone(vi: number, mi: number) {
    const vote = rawVotes[vi];
    milestones[mi].vote = {
      chamber: vote.chamber,
      result: vote.result,
      ayes: vote.ayes,
      noes: vote.noes,
      ayesDem: vote.ayesDem,
      ayesRep: vote.ayesRep,
      noesDem: vote.noesDem,
      noesRep: vote.noesRep,
    };
    matchedVoteIndices.add(vi);
    claimedMilestoneIndices.add(mi);
  }

  // Pass 1: match by label similarity, prefer closest in time to avoid grabbing
  // the wrong milestone when multiple votes share the same chamber label.
  for (let vi = 0; vi < rawVotes.length; vi++) {
    if (matchedVoteIndices.has(vi)) continue;
    const vote = rawVotes[vi];
    const voteDate = vote.date
      ? parseDisplayDateToISO(vote.date) ?? vote.date
      : undefined;

    let bestMi = -1;
    let bestDiff = Infinity;

    for (let mi = 0; mi < milestones.length; mi++) {
      if (claimedMilestoneIndices.has(mi)) continue;
      if (voteLabelMatch(vote.chamber, milestones[mi].label)) {
        if (voteDate) {
          const vd = new Date(voteDate).getTime();
          const md = new Date(milestones[mi].sortDate).getTime();
          const diff =
            !isNaN(vd) && !isNaN(md) ? Math.abs(vd - md) : Infinity;
          if (diff < bestDiff) {
            bestDiff = diff;
            bestMi = mi;
          }
        } else {
          // No vote date available — take the first label match
          bestMi = mi;
          break;
        }
      }
    }

    if (bestMi >= 0) {
      assignVoteToMilestone(vi, bestMi);
    }
  }

  // Pass 2: match remaining by date proximity (within 1 day)
  for (let vi = 0; vi < rawVotes.length; vi++) {
    if (matchedVoteIndices.has(vi)) continue;
    const vote = rawVotes[vi];
    const voteDate = vote.date
      ? parseDisplayDateToISO(vote.date) ?? vote.date
      : undefined;
    if (!voteDate) continue;
    for (let mi = 0; mi < milestones.length; mi++) {
      if (claimedMilestoneIndices.has(mi)) continue;
      if (voteDateMatch(voteDate, milestones[mi].sortDate)) {
        assignVoteToMilestone(vi, mi);
        break;
      }
    }
  }

  const unmatchedVotes = rawVotes.filter((_, i) => !matchedVoteIndices.has(i));

  // Step 3: Parse amendments and unmatched votes with sort dates
  const parsedAmendments = rawAmendments.map((a) => ({
    ...a,
    sortDate: parseDisplayDateToISO(a.date) ?? a.date,
  }));

  // Parse unmatched votes with sort dates
  const parsedVotes = unmatchedVotes.map((v) => ({
    ...v,
    sortDate: v.date ? parseDisplayDateToISO(v.date) ?? v.date : "",
  }));

  // Step 4: Assign amendments and unmatched votes to milestones.
  // Everything between milestone N and milestone N+1 goes under milestone N.
  // Items that fall before the first milestone (or when there are no milestones
  // at all) are collected into orphanChildren and surfaced via a synthetic
  // milestone, so they are not silently dropped.
  const orphanChildren: TimelineChild[] = [];

  for (const amendment of parsedAmendments) {
    const milestoneIdx = findMilestoneIndex(milestones, amendment.sortDate);
    const target =
      milestoneIdx >= 0 ? milestones[milestoneIdx].children : orphanChildren;
    target.push({
      type: "amendment",
      sortDate: amendment.sortDate,
      date: amendment.date,
      description: amendment.description,
      url: amendment.url,
      author: amendment.author,
    });
  }

  for (const vote of parsedVotes) {
    if (!vote.sortDate) continue;
    const milestoneIdx = findMilestoneIndex(milestones, vote.sortDate);
    const target =
      milestoneIdx >= 0 ? milestones[milestoneIdx].children : orphanChildren;
    target.push({
      type: "vote",
      sortDate: vote.sortDate,
      chamber: vote.chamber,
      date: vote.date ?? "",
      result: vote.result,
      ayes: vote.ayes,
      noes: vote.noes,
      ayesDem: vote.ayesDem,
      ayesRep: vote.ayesRep,
      noesDem: vote.noesDem,
      noesRep: vote.noesRep,
    });
  }

  // Insert a synthetic milestone at the front for any unmatched items
  if (orphanChildren.length > 0) {
    milestones.unshift({
      sortDate: "0000-01-01",
      displayDate: "",
      label: "Unmatched events",
      color: "bg-gray-500",
      children: orphanChildren,
    });
  }

  // Sort children within each milestone by date
  for (const m of milestones) {
    m.children.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
  }

  // Step 5: Assign resources as flat children of milestones (sorted chronologically)
  const datedResources = rawResources
    .filter((r) => r.publishedDate)
    .map((r) => ({
      ...r,
      publishedDate: r.publishedDate!,
      sortDate: r.publishedDate!,
    }));

  const earlyCoverage: TimelineResourceChild[] = [];

  for (const resource of datedResources) {
    const resChild: TimelineResourceChild = {
      type: "resource",
      id: resource.id,
      title: resource.title,
      url: resource.url,
      domain: resource.domain,
      publishedDate: resource.publishedDate,
      sortDate: resource.sortDate,
      category: resource.category,
    };

    const milestoneIdx = findMilestoneIndex(milestones, resource.sortDate);
    if (milestoneIdx < 0) {
      earlyCoverage.push(resChild);
    } else {
      milestones[milestoneIdx].children.push(resChild);
    }
  }

  // Re-sort children (resources interleaved with amendments/votes by date)
  for (const m of milestones) {
    m.children.sort((a, b) => a.sortDate.localeCompare(b.sortDate));
  }

  // Sort early coverage by date
  earlyCoverage.sort((a, b) => a.sortDate.localeCompare(b.sortDate));

  // Undated resources go in a separate section
  const undatedResources: TimelineResourceChild[] = rawResources
    .filter((r) => !r.publishedDate)
    .map((r) => ({
      type: "resource" as const,
      id: r.id,
      title: r.title,
      url: r.url,
      domain: r.domain,
      publishedDate: "",
      sortDate: "",
      category: r.category,
    }));

  return { earlyCoverage, milestones, undatedResources };
}

/**
 * Find which milestone index a date belongs to.
 * Returns the index of the latest milestone whose sortDate <= the given date.
 * Returns -1 if the date is before all milestones.
 */
function findMilestoneIndex(
  milestones: TimelineMilestone[],
  date: string
): number {
  let result = -1;
  for (let i = 0; i < milestones.length; i++) {
    if (milestones[i].sortDate <= date) {
      result = i;
    } else {
      break;
    }
  }
  return result;
}
