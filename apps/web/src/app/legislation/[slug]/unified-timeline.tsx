import { safeHref } from "@/lib/format-compact";
import type {
  UnifiedTimeline,
  TimelineMilestone,
  TimelineChild,
  TimelineResourceChild,
} from "./timeline-utils";

// ── Helpers ─────────────────────────────────────────────────────────────

function getMilestoneDotColor(label: string): string {
  if (label === "Introduced") return "bg-blue-500";
  if (label === "Signed" || label === "Enacted" || label === "Effective" || label === "In Force")
    return "bg-green-500";
  if (label === "Vetoed") return "bg-red-500";
  return "bg-violet-500";
}

function getMilestoneRingColor(label: string): string {
  if (label === "Introduced") return "ring-blue-500/20";
  if (label === "Signed" || label === "Enacted" || label === "Effective" || label === "In Force")
    return "ring-green-500/20";
  if (label === "Vetoed") return "ring-red-500/20";
  return "ring-violet-500/20";
}

const MONTH_NAMES: Record<string, string> = {
  "01": "Jan", "02": "Feb", "03": "Mar", "04": "Apr",
  "05": "May", "06": "Jun", "07": "Jul", "08": "Aug",
  "09": "Sep", "10": "Oct", "11": "Nov", "12": "Dec",
};

function formatShortDate(iso: string): string {
  if (!iso) return "";
  const parts = iso.split("-");
  if (parts.length >= 3) {
    const month = MONTH_NAMES[parts[1]] ?? parts[1];
    const day = parseInt(parts[2], 10);
    return `${month} ${day}`;
  }
  if (parts.length === 2) {
    return `${MONTH_NAMES[parts[1]] ?? parts[1]} ${parts[0]}`;
  }
  return iso;
}

function formatVoteSummary(vote: NonNullable<TimelineMilestone["vote"]>): string {
  const parts: string[] = [];
  if (vote.ayes != null && vote.noes != null) {
    parts.push(`${vote.ayes}\u2013${vote.noes}`);
  }
  const ayeParts: string[] = [];
  const noeParts: string[] = [];
  if (vote.ayesDem != null) ayeParts.push(`${vote.ayesDem}D`);
  if (vote.ayesRep != null) ayeParts.push(`${vote.ayesRep}R`);
  if (vote.noesDem != null) noeParts.push(`${vote.noesDem}D`);
  if (vote.noesRep != null) noeParts.push(`${vote.noesRep}R`);
  if (ayeParts.length > 0 || noeParts.length > 0) {
    parts.push(`${ayeParts.join("+")} / ${noeParts.join("+")}`);
  }
  return parts.join(", ");
}

// ── Resource link ───────────────────────────────────────────────────────

function ResourceLink({ resource }: { resource: TimelineResourceChild }) {
  const shortDate = formatShortDate(resource.publishedDate);
  return (
    <div className="group flex items-baseline gap-1.5 py-0.5 min-w-0">
      <span className="text-muted-foreground/30 shrink-0 text-[10px] leading-none mt-px select-none">&bull;</span>
      <div className="flex-1 min-w-0 flex items-baseline justify-between gap-2">
        <a
          href={safeHref(resource.url)}
          target="_blank"
          rel="noopener noreferrer"
          className="text-[13px] text-muted-foreground hover:text-foreground transition-colors truncate"
          title={resource.title}
        >
          {resource.title}
        </a>
        {(resource.domain || shortDate) && (
          <span className="text-[11px] text-muted-foreground/40 whitespace-nowrap shrink-0">
            {[resource.domain, shortDate].filter(Boolean).join(" \u00b7 ")}
          </span>
        )}
      </div>
    </div>
  );
}

function ResourceList({ resources }: { resources: TimelineResourceChild[] }) {
  if (resources.length === 0) return null;
  return (
    <div className="mt-1 space-y-0 ml-0.5">
      {resources.map((r) => (
        <ResourceLink key={r.id} resource={r} />
      ))}
    </div>
  );
}

// ── Child items ─────────────────────────────────────────────────────────

function AmendmentEntry({
  child,
}: {
  child: Extract<TimelineChild, { type: "amendment" }>;
}) {
  return (
    <div className="relative pl-5">
      <div className="absolute left-0 top-[6px] w-2 h-2 rounded-full bg-amber-400/60 dark:bg-amber-500/40" />
      <div>
        <div className="flex items-baseline justify-between gap-3">
          <div className="flex-1 min-w-0">
            <span className="text-[11px] font-medium uppercase tracking-wider text-amber-600/70 dark:text-amber-400/60 mr-1.5">
              Amended
            </span>
            <span className="text-sm text-foreground/80">
              {child.description}
            </span>
            {child.url && (
              <a
                href={child.url}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center ml-1.5 text-[11px] text-primary/50 hover:text-primary transition-colors"
              >
                PDF &#8599;
              </a>
            )}
            {child.author && (
              <span className="text-[12px] text-muted-foreground/40 ml-1.5">
                by {child.author}
              </span>
            )}
          </div>
          <span className="text-[12px] text-muted-foreground/40 whitespace-nowrap shrink-0 tabular-nums">
            {child.date}
          </span>
        </div>
      </div>
      <ResourceList resources={child.resources} />
    </div>
  );
}

function VoteEntry({
  child,
}: {
  child: Extract<TimelineChild, { type: "vote" }>;
}) {
  return (
    <div className="relative pl-5">
      <div className="absolute left-0 top-[6px] w-2 h-2 rounded-full bg-blue-400/60 dark:bg-blue-500/40" />
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-1.5 flex-wrap">
          <span className="text-[11px] font-medium uppercase tracking-wider text-blue-600/70 dark:text-blue-400/60">
            Vote
          </span>
          <span className="text-sm font-medium">{child.chamber}</span>
          {child.ayes != null && child.noes != null && (
            <span className="text-[13px] text-muted-foreground/50 tabular-nums">
              {child.ayes}&ndash;{child.noes}
            </span>
          )}
        </div>
        {child.date && (
          <span className="text-[12px] text-muted-foreground/40 whitespace-nowrap shrink-0 tabular-nums">
            {child.date}
          </span>
        )}
      </div>
      <ResourceList resources={child.resources} />
    </div>
  );
}

// ── Milestone ───────────────────────────────────────────────────────────

function MilestoneEntry({
  milestone,
  isLast,
}: {
  milestone: TimelineMilestone;
  isLast: boolean;
}) {
  const dotColor = getMilestoneDotColor(milestone.label);
  const ringColor = getMilestoneRingColor(milestone.label);
  const vote = milestone.vote;
  const voteStr = vote ? formatVoteSummary(vote) : null;
  const hasChildren = milestone.children.length > 0;

  // Show chamber name from merged vote if it adds specificity
  // e.g. "Passed Committee" + vote.chamber="Senate Judiciary Committee" → show the chamber
  const chamberDetail =
    vote?.chamber && !milestone.label.toLowerCase().includes(vote.chamber.toLowerCase())
      ? vote.chamber
      : null;

  return (
    <div className="relative">
      {/* Vertical connector line */}
      {!isLast && (
        <div className="absolute left-[9px] top-[20px] bottom-0 w-px bg-border" />
      )}

      {/* Milestone header row */}
      <div className="flex items-start gap-3">
        <div className="relative shrink-0 mt-0.5">
          <div className={`w-[20px] h-[20px] rounded-full ${dotColor} ring-4 ${ringColor}`} />
        </div>

        <div className="flex-1 min-w-0 flex items-baseline justify-between gap-2 pb-1">
          <div className="flex items-baseline gap-2 flex-wrap">
            <span className="font-semibold text-[15px] text-foreground">
              {milestone.label}
            </span>
            {chamberDetail && (
              <span className="text-[13px] text-muted-foreground/50">
                {chamberDetail}
              </span>
            )}
            {voteStr && (
              <span className="text-[13px] text-muted-foreground/40 tabular-nums">
                {voteStr}
              </span>
            )}
          </div>
          <span className="text-[13px] text-muted-foreground/40 whitespace-nowrap tabular-nums">
            {milestone.displayDate}
          </span>
        </div>
      </div>

      {/* Children */}
      {hasChildren && (
        <div className="ml-[9px] pl-[22px] border-l border-border space-y-2 pb-2 pt-1">
          {milestone.children.map((child, i) => {
            if (child.type === "amendment") {
              return (
                <AmendmentEntry
                  key={`a-${child.sortDate}-${i}`}
                  child={child}
                />
              );
            }
            if (child.type === "vote") {
              return (
                <VoteEntry
                  key={`v-${child.chamber}-${i}`}
                  child={child}
                />
              );
            }
            return <ResourceLink key={child.id} resource={child} />;
          })}
        </div>
      )}

      {!hasChildren && !isLast && <div className="h-2" />}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

interface UnifiedTimelineViewProps {
  timeline: UnifiedTimeline;
}

export function UnifiedTimelineView({ timeline }: UnifiedTimelineViewProps) {
  const { earlyCoverage, milestones } = timeline;
  const totalEvents =
    milestones.length +
    milestones.reduce((sum, m) => sum + m.children.length, 0);

  if (totalEvents === 0 && earlyCoverage.length === 0) return null;

  return (
    <div>
      {earlyCoverage.length > 0 && (
        <div className="mb-6 ml-8">
          <p className="text-xs font-medium text-muted-foreground/50 uppercase tracking-widest mb-2">
            Before first milestone
          </p>
          <div className="space-y-0">
            {earlyCoverage.map((r) => (
              <ResourceLink key={r.id} resource={r} />
            ))}
          </div>
        </div>
      )}

      {milestones.length > 0 && (
        <div className="space-y-1">
          {milestones.map((milestone, i) => (
            <MilestoneEntry
              key={`${milestone.label}-${i}`}
              milestone={milestone}
              isLast={i === milestones.length - 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
