import { parseDisplayDateToISO } from "@/app/legislation/[slug]/date-utils";

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
  // US state legislatures
  "senate floor": ["passed senate"],
  "assembly floor": ["passed assembly"],
  "house floor": ["passed house"],
  "senate concurrence": ["passed legislature"],
  "house concurrence": ["passed legislature"],
  "assembly concurrence": ["passed legislature"],
  // State-prefixed chambers (e.g., NY Senate, NY Assembly)
  "ny senate": ["passed senate", "passed legislature"],
  "ny assembly": ["passed assembly", "passed legislature"],
  // Executive actions
  governor: ["signed", "enacted", "vetoed"],
  president: ["signed", "enacted", "vetoed"],
  "executive order": ["signed", "enacted", "effective"],
  // International / diplomatic
  summit: ["signed", "signed on", "adopted", "agreed"],
  // EU institutions
  "european parliament (final adoption)": [
    "parliament final vote",
    "passed parliament",
  ],
  "european parliament (negotiating mandate)": [
    "parliament negotiating mandate",
  ],
  "council of the european union": ["council adoption", "council adopted"],
};

function voteLabelMatch(voteChamber: string, milestoneLabel: string): boolean {
  const chamberKey = voteChamber.toLowerCase();
  const labelKey = milestoneLabel.toLowerCase();
  const matchLabels = CHAMBER_TO_MILESTONE[chamberKey];
  return matchLabels !== undefined && matchLabels.includes(labelKey);
}

/**
 * Check if a display date string is month-only (e.g., "April 2024", "2024-05").
 * Month-only dates get parsed to YYYY-MM-01 by parseDisplayDateToISO,
 * so we detect them from the original display string to allow wider matching.
 */
function isMonthOnlyDisplay(display: string): boolean {
  // "April 2024", "May 2024", etc.
  if (/^[A-Za-z]+\s+\d{4}$/.test(display.trim())) return true;
  // "2024-05" (ISO month-only)
  if (/^\d{4}-\d{2}$/.test(display.trim())) return true;
  return false;
}

/**
 * Match vote and milestone dates, accounting for month-only granularity.
 * When either date is month-only, matching is by same year-month.
 * Otherwise, matching is within 1 day (86400000 ms).
 */
function voteDateMatch(
  voteDate: string,
  milestoneDate: string,
  voteDisplay?: string,
  milestoneDisplay?: string
): boolean {
  const vd = new Date(voteDate).getTime();
  const md = new Date(milestoneDate).getTime();
  if (isNaN(vd) || isNaN(md)) return false;

  // If either date is month-only, match by year-month
  const voteMonthOnly = voteDisplay ? isMonthOnlyDisplay(voteDisplay) : false;
  const milestoneMonthOnly = milestoneDisplay
    ? isMonthOnlyDisplay(milestoneDisplay)
    : false;

  if (voteMonthOnly || milestoneMonthOnly) {
    // Compare YYYY-MM prefix (first 7 chars of ISO date)
    return voteDate.slice(0, 7) === milestoneDate.slice(0, 7);
  }

  return Math.abs(vd - md) <= 86400000;
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

  // Pass 2: match remaining by date proximity (within 1 day, or same month
  // if either date is month-only granularity)
  for (let vi = 0; vi < rawVotes.length; vi++) {
    if (matchedVoteIndices.has(vi)) continue;
    const vote = rawVotes[vi];
    const voteDate = vote.date
      ? parseDisplayDateToISO(vote.date) ?? vote.date
      : undefined;
    if (!voteDate) continue;
    for (let mi = 0; mi < milestones.length; mi++) {
      if (claimedMilestoneIndices.has(mi)) continue;
      if (
        voteDateMatch(
          voteDate,
          milestones[mi].sortDate,
          vote.date,
          milestones[mi].displayDate
        )
      ) {
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
  // Items that fall before the first milestone are attached to the nearest
  // milestone (the first one) so they're not silently dropped or pushed into
  // a confusing "Unmatched events" bucket.

  for (const amendment of parsedAmendments) {
    const milestoneIdx = findNearestMilestoneIndex(
      milestones,
      amendment.sortDate
    );
    if (milestoneIdx >= 0) {
      milestones[milestoneIdx].children.push({
        type: "amendment",
        sortDate: amendment.sortDate,
        date: amendment.date,
        description: amendment.description,
        url: amendment.url,
        author: amendment.author,
      });
    }
    // If no milestones at all, the amendment is silently dropped (no bucket).
    // This only happens when rawMilestones is empty.
  }

  for (const vote of parsedVotes) {
    if (!vote.sortDate) continue;
    const milestoneIdx = findNearestMilestoneIndex(milestones, vote.sortDate);
    if (milestoneIdx >= 0) {
      milestones[milestoneIdx].children.push({
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

/**
 * Find the nearest milestone for a date, falling back to the first milestone
 * when the date is before all milestones. This prevents orphan items from
 * being pushed into an "Unmatched events" synthetic milestone.
 *
 * Returns -1 only if there are no milestones at all.
 */
function findNearestMilestoneIndex(
  milestones: TimelineMilestone[],
  date: string
): number {
  if (milestones.length === 0) return -1;
  const idx = findMilestoneIndex(milestones, date);
  // If before all milestones, attach to the first one
  return idx >= 0 ? idx : 0;
}
