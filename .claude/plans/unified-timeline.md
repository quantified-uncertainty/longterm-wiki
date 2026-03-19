# Plan: Unified Legislation Timeline (#2778)

## Problem
Legislation pages display history in 3 separate places:
1. **Legislative Timeline** (Overview tab) — milestone events (Introduced, Passed Committee, Vetoed)
2. **Amendment History** (History tab) — amendment dates with descriptions + Key Politicians
3. **Coverage Timeline** (Documents & Press tab) — events + press resources grouped together

This fragments the chronological story. A single unified timeline should replace all three.

## Design Decisions

### No arbitrary time windows
The old Coverage Timeline used a 30-day window to attach press to events. This is arbitrary and causes orphan resources. Instead: **attach each resource to the nearest preceding event, regardless of time gap.** Resources before the first event go in an "Early Coverage" section.

### Nested: milestones are parents, everything else nests under them
The bill's lifecycle has natural phases defined by milestones (Introduced → Committee → Floor → Executive). Amendments, votes, and resources that happen *between* two milestones are logically *about* that phase. Nesting makes causal relationships visible:

```
● Introduced                                February 2024
  ◆ Amendment: March 20 — defined thresholds
  ◆ Amendment: April 8 — refined definitions
  ○ DLA Piper early analysis                 Feb 1

● Passed Committee (9-0)                    April 2, 2024
  ◆ Amendment: April 16 — enforcement
  ◆ Amendment: April 30 — capability defs

● Passed Senate (32-1, 30D+2R)             May 21, 2024
  ◆ Amendment: June 20 — safe harbors
  ◆ Amendment: July 3 — compute reporting
  ○ Orrick analysis                          Jul 1

● Assembly Hearings
  ◆ Amendment: Aug 19 — MAJOR overhaul
  ◆ Amendment: Aug 22 — final cleanup
  ○ Pelosi opposition                        Aug 22
  ○ Elon Musk endorsement                    Aug 26

● Passed Assembly (48-16, 44D+4R)          August 28, 2024

● Passed Legislature (30-9 concurrence)    August 29, 2024
  ○ 113-employee letter                      Sep 9

● Vetoed                                    September 29, 2024
  ○ NYT, WaPo, CalMatters coverage           Sep 29
  ○ Carnegie Endowment analysis              Oct
```

The nesting rule: everything between milestone N and milestone N+1 nests under milestone N. Resources nest under the nearest preceding event of any type (milestone, amendment, or vote) — not just the nearest milestone. This is more natural: if a resource was published the day after an amendment, it's about that amendment. Votes can either be milestones themselves (if they correspond to a customField like "Passed Senate") or nest under the preceding milestone.

### Event types have different visual weight
Not all events are equal:
- **Milestones** (Introduced, Passed Committee, Vetoed) are the major beats — bold, colored dots
- **Amendments** are supporting detail — smaller, amber, with expandable descriptions
- **Votes** are data-rich — show inline results with party breakdown
- **Resources** are the lightest — small dots, indented under the preceding event

### Resources are NOT events
Resources don't go on the main timeline spine. They nest under the nearest preceding event. A resource published Aug 22 (Pelosi statement) appears under the "Passed Assembly" event (Aug 28) if that's the nearest, or under whatever event precedes it chronologically. This preserves the event→coverage relationship.

### What about resources with no preceding event?
Resources published before "Introduced" (e.g., early analysis) go in an "Early Coverage" group at the top of the timeline, before the first event.

### What about resources between events far apart?
If "Passed Committee" is April and "Passed Senate" is May, and a resource is published April 15, it appears under "Passed Committee." No time limit — just nearest preceding event.

## Data Model

### Data Types
```typescript
// A milestone is a top-level phase marker
interface TimelineMilestone {
  sortDate: string;
  displayDate: string;
  label: string;             // "Introduced", "Passed Committee", "Vetoed"
  color: string;             // dot color class
  // If this milestone corresponds to a vote, include vote data
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
  // Children: everything between this milestone and the next
  children: TimelineChild[];
}

// Children nest under milestones
type TimelineChild =
  | { type: "amendment"; sortDate: string; date: string; description: string; url?: string; author?: string }
  | { type: "vote"; sortDate: string; chamber: string; date: string; result: string; ayes?: number; noes?: number; ayesDem?: number; ayesRep?: number; noesDem?: number; noesRep?: number }
  | { type: "resource"; id: string; title: string; url: string; domain: string | null; publishedDate: string; category: "official" | "analysis" | "press" };

// The full timeline
interface UnifiedTimeline {
  earlyCoverage: TimelineChild[];  // resources before first milestone
  milestones: TimelineMilestone[];  // ordered oldest-first
  // No lateCoverage — resources after the last milestone nest under the last milestone
}
```

### Data Sources (all from existing TableBase)
- `entity.customFields` filtered by TIMELINE_LABELS → milestone entries
- `entity.amendments` → amendment entries
- `entity.votes` → vote entries
- `pressResources` from `getResourcesForPage()` → attached to sections

### Merge Algorithm
```
1. Parse milestones from customFields (sorted oldest-first):
   - "Introduced" → milestone { label: "Introduced", date: "February 2024", color: "blue" }
   - "Passed Committee" → milestone { label: "Passed Committee", date: "April 2024", color: "violet" }
   - etc.

2. Merge milestones with matching votes:
   - "Passed Senate" milestone (May 21) matches "Senate Floor" vote (May 21)
   - Merge: milestone keeps its label but gains vote.ayes/noes/party data
   - Unmatched votes become children of the nearest preceding milestone

3. For each milestone, collect children (things between this milestone and the next):
   a. Amendments with sortDate between milestone N and milestone N+1
   b. Unmatched votes with date between milestone N and milestone N+1
   c. Resources with publishedDate between milestone N and milestone N+1
   Sort children by date within each milestone.

4. Resources/amendments before the first milestone → earlyCoverage
   Resources after the last milestone → lateCoverage (or nest under last milestone)
```

### Milestone ↔ Vote Deduplication
"Passed Assembly" (customField) and "Assembly Floor" (vote) are the same event. Match by:
- Date match (same day or within 1 day)
- OR label similarity ("Passed Senate" ↔ "Senate Floor", "Passed Assembly" ↔ "Assembly Floor")

When matched: use the customField label (it's more readable) but attach the vote data (ayes, noes, party breakdown). The merged milestone shows both:
```
● Passed Assembly (48-16, 44D+4R / 1D+15R)    August 28, 2024
```

## Visual Design

```
● Introduced                                    February 2024
  ○ DLA Piper: Understanding SB-1047            Feb 1 · press

◆ Amendment: March 20, 2024
  Defined covered model thresholds (>10^26 FLOP or >$100M)
  View PDF ↗

● Passed Committee (9-0)                        April 2, 2024

◆ Amendment: April 8, 2024
  Refined definitions and exemptions

◆ Amendment: April 16, 2024
  Adjusted enforcement provisions

◆ Amendment: April 30, 2024
  Narrowed hazardous capability definitions

■ Senate Floor                                  May 21, 2024
  32-1 (30D+2R / 0D+1R)

◆ Amendment: June 20, 2024
  Added safe harbors; reduced liability to negligence standard
  ○ Orrick analysis                              Jul 1 · press

◆ Amendment: July 3, 2024
  Clarified compute cluster reporting

◆ Amendment: August 19, 2024  by Senator Wiener
  Major overhaul: removed FMD, criminal penalties...
  View PDF ↗
  ○ Pelosi opposition statement                  Aug 22 · press
  ○ Morgan Lewis analysis                        Aug 1 · press

■ Assembly Floor                                August 28, 2024
  48-16 (44D+4R / 1D+15R)

■ Senate Concurrence                            August 29, 2024
  30-9 (29D+1R / 0D+9R)

  ○ 113-employee letter to Newsom                Sep 9 · press

● Vetoed                                        September 29, 2024
  ○ NYT: California AI Safety Bill Veto          Sep 29 · press
  ○ WaPo: Newsom Vetoes AI Bill                  Sep 29 · press
  ○ CalMatters analysis                          Sep 1 · press
  ○ Carnegie Endowment analysis                  Sep 1 · press
```

Design elements:
- **●** Large colored dot = milestone (violet=progress, red=veto, green=signed)
- **◆** Small amber diamond = amendment
- **■** Blue square = vote (with inline results)
- **○** Tiny gray dot = resource (indented under parent event)
- Left border line connecting all entries
- Amendment descriptions in muted smaller text, collapsible if long
- Vote results inline with party breakdown
- Resource titles as links with domain + short date
- Chronological: oldest at top, newest at bottom

## Tab Structure

### Before
- Overview: description, pipeline, Legislative Timeline, Voting Record, Veto Rationale, Related Legislation, Related Topics, FactBase, Related Pages + sidebar
- Provisions (8)
- Stakeholders (38)
- History (13): Amendment History + Key Politicians
- Documents & Press (29): Coverage Timeline + Resource Table

### After
- Overview: description, pipeline, Veto Rationale, Related Legislation, Related Topics, Key Politicians, FactBase, Related Pages + sidebar
- **Timeline**: unified chronological view ← NEW (replaces Legislative Timeline + Amendment History + Coverage Timeline)
- Provisions (8)
- Stakeholders (38)
- Documents & Press: resource TABLE only (searchable, filterable — the table view is still valuable)

### What gets removed
- Legislative Timeline section from Overview → merged into Timeline tab
- History tab entirely → amendments go to Timeline, Key Politicians move to Overview
- Coverage Timeline from Documents & Press → merged into Timeline tab

### What stays
- Voting Record stays embedded in the Timeline (votes are events with inline data)
- Documents & Press tab keeps the resource TABLE view (different purpose: search/filter vs chronological story)
- Key Politicians moves to Overview (near sidebar, not buried in History)

## Implementation Steps

1. Create `apps/web/src/app/legislation/[slug]/unified-timeline.tsx`
   - Server component
   - Takes: milestones, amendments, votes, resources as props
   - Implements merge algorithm
   - Renders the timeline

2. Create `apps/web/src/app/legislation/[slug]/timeline-utils.ts`
   - `parseDisplayDateToISO()` — already exists in date-utils.ts
   - `mergeTimelineEntries()` — the merge + sort + resource attachment logic
   - `deduplicateVotesAndMilestones()` — merge overlapping events

3. Update `apps/web/src/app/legislation/[slug]/page.tsx`
   - Add Timeline tab using UnifiedTimeline component
   - Remove Legislative Timeline from Overview
   - Remove History tab
   - Move Key Politicians to Overview (after Related Topics, before FactBase)
   - Keep Documents & Press with just the resource table
   - Keep Voting Record table in Overview OR as part of Timeline

4. Type-check and build

5. Visual verification — compare with the current 3-view layout

## Files
- `apps/web/src/app/legislation/[slug]/unified-timeline.tsx` — NEW
- `apps/web/src/app/legislation/[slug]/timeline-utils.ts` — NEW (or extend date-utils.ts)
- `apps/web/src/app/legislation/[slug]/page.tsx` — restructure tabs
- `apps/web/src/app/legislation/[slug]/resource-timeline.tsx` — can be removed after migration

## Edge Cases
- Bills with no amendments (e.g., executive orders) → timeline shows only milestones + resources
- Bills with no votes (e.g., voluntary commitments) → no vote entries
- Bills with no press resources → timeline shows events only, no nested resources
- Resources with no date → shown in a separate "Undated Resources" section below the timeline
- Multiple events on the same day → shown in order: milestone > vote > amendment
