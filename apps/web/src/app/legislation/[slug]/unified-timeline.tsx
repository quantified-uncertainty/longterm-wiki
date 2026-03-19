import { safeHref } from "@/lib/format-compact";
import type {
  UnifiedTimeline,
  TimelineMilestone,
  TimelineChild,
  TimelineResourceChild,
} from "./timeline-utils";

// ── Color helpers ───────────────────────────────────────────────────────

function getMilestoneTextColor(label: string): string {
  if (label === "Introduced") return "text-blue-700 dark:text-blue-400";
  if (
    label === "Signed" ||
    label === "Enacted" ||
    label === "Effective" ||
    label === "In Force"
  )
    return "text-green-700 dark:text-green-400";
  if (label === "Vetoed") return "text-red-700 dark:text-red-400";
  return "text-violet-700 dark:text-violet-400";
}

function getCategoryBadge(category: "official" | "analysis" | "press"): {
  label: string;
  className: string;
} {
  switch (category) {
    case "official":
      return {
        label: "Official",
        className:
          "bg-blue-100 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
      };
    case "analysis":
      return {
        label: "Analysis",
        className:
          "bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-300",
      };
    case "press":
      return {
        label: "Press",
        className:
          "bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300",
      };
  }
}

// ── Format helpers ──────────────────────────────────────────────────────

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

function formatVoteInline(vote: NonNullable<TimelineMilestone["vote"]>): string {
  const parts: string[] = [];
  if (vote.ayes != null && vote.noes != null) {
    parts.push(`${vote.ayes}-${vote.noes}`);
  }
  // Party breakdown
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

// ── Sub-components ──────────────────────────────────────────────────────

function ResourceItem({ resource }: { resource: TimelineResourceChild }) {
  const badge = getCategoryBadge(resource.category);
  const shortDate = formatShortDate(resource.publishedDate);
  return (
    <div className="flex items-start gap-2 py-0.5 group">
      <div className="relative flex items-center justify-center mt-1.5 shrink-0 w-4">
        <div className="w-1.5 h-1.5 rounded-full bg-muted-foreground/25 group-hover:bg-muted-foreground/50 transition-colors" />
      </div>
      <div className="flex-1 min-w-0">
        <div className="flex items-baseline gap-2 flex-wrap">
          <a
            href={safeHref(resource.url)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-sm text-primary hover:underline truncate max-w-[28rem]"
            title={resource.title}
          >
            {resource.title}
          </a>
          <span
            className={`inline-flex items-center px-1.5 py-0 rounded text-[9px] font-semibold uppercase tracking-wide ${badge.className}`}
          >
            {badge.label}
          </span>
        </div>
        <div className="flex items-center gap-2 text-xs text-muted-foreground/60 mt-0.5">
          {resource.domain && <span>{resource.domain}</span>}
          {shortDate && <span>{shortDate}</span>}
        </div>
      </div>
    </div>
  );
}

function ChildResources({
  resources,
}: {
  resources: TimelineResourceChild[];
}) {
  if (resources.length === 0) return null;
  return (
    <div className="mt-0.5 ml-3 border-l border-border/30 pl-2 space-y-0">
      {resources.map((r) => (
        <ResourceItem key={r.id} resource={r} />
      ))}
    </div>
  );
}

function AmendmentItem({
  child,
}: {
  child: Extract<TimelineChild, { type: "amendment" }>;
}) {
  return (
    <div className="relative">
      <div className="absolute -left-[23px] top-1.5 w-2.5 h-2.5 rotate-45 bg-amber-500 border-2 border-background" />
      <div>
        <div className="flex items-baseline gap-2 mb-0.5 flex-wrap">
          <span className="text-xs font-semibold uppercase tracking-wider text-amber-600 dark:text-amber-400">
            Amendment
          </span>
          {child.url ? (
            <a
              href={child.url}
              target="_blank"
              rel="noopener noreferrer"
              className="font-semibold text-sm text-primary hover:underline"
            >
              {child.date}
            </a>
          ) : (
            <span className="font-semibold text-sm">{child.date}</span>
          )}
          {child.author && (
            <span className="text-xs text-muted-foreground">
              by {child.author}
            </span>
          )}
        </div>
        <p className="text-sm text-muted-foreground leading-relaxed">
          {child.description}
        </p>
      </div>
      <ChildResources resources={child.resources} />
    </div>
  );
}

function VoteItem({
  child,
}: {
  child: Extract<TimelineChild, { type: "vote" }>;
}) {
  const isPass =
    child.result.toLowerCase().includes("pass") ||
    child.result.toLowerCase().includes("sign") ||
    child.result.toLowerCase().includes("adopt");
  return (
    <div className="relative">
      <div
        className={`absolute -left-[23px] top-1.5 w-2.5 h-2.5 rounded-sm ${
          isPass ? "bg-blue-500" : "bg-red-400"
        } border-2 border-background`}
      />
      <div className="flex items-baseline gap-2 flex-wrap">
        <span className="font-semibold text-sm">{child.chamber}</span>
        <span
          className={`inline-flex items-center px-2 py-0.5 rounded-full text-[10px] font-semibold ${
            isPass
              ? "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300"
              : "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300"
          }`}
        >
          {child.result}
        </span>
        {child.ayes != null && child.noes != null && (
          <span className="text-sm text-muted-foreground tabular-nums">
            {child.ayes}-{child.noes}
          </span>
        )}
        {child.date && (
          <span className="text-sm text-muted-foreground">{child.date}</span>
        )}
      </div>
      {/* Party breakdown */}
      {(child.ayesDem != null || child.ayesRep != null) && (
        <div className="text-xs text-muted-foreground/70 mt-0.5 ml-0.5">
          {child.ayesDem != null && (
            <span className="text-blue-600 dark:text-blue-400">
              {child.ayesDem}D
            </span>
          )}
          {child.ayesDem != null && child.ayesRep != null && "+"}
          {child.ayesRep != null && (
            <span className="text-red-500 dark:text-red-400">
              {child.ayesRep}R
            </span>
          )}
          {" / "}
          {child.noesDem != null && (
            <span className="text-blue-600 dark:text-blue-400">
              {child.noesDem}D
            </span>
          )}
          {child.noesDem != null && child.noesRep != null && "+"}
          {child.noesRep != null && (
            <span className="text-red-500 dark:text-red-400">
              {child.noesRep}R
            </span>
          )}
        </div>
      )}
      <ChildResources resources={child.resources} />
    </div>
  );
}

function MilestoneEntry({ milestone }: { milestone: TimelineMilestone }) {
  const textColor = getMilestoneTextColor(milestone.label);
  const voteStr = milestone.vote ? formatVoteInline(milestone.vote) : null;

  return (
    <div className="relative">
      {/* Milestone dot */}
      <div
        className={`absolute -left-[27px] top-0.5 w-4 h-4 rounded-full border-2 border-background ${milestone.color}`}
      />
      <div className="flex items-baseline justify-between gap-3">
        <div className="flex items-baseline gap-2 flex-wrap">
          <span className={`font-bold text-base ${textColor}`}>
            {milestone.label}
          </span>
          {voteStr && (
            <span className="text-sm text-muted-foreground tabular-nums">
              ({voteStr})
            </span>
          )}
        </div>
        <span className="text-sm text-muted-foreground whitespace-nowrap">
          {milestone.displayDate}
        </span>
      </div>

      {/* Children */}
      {milestone.children.length > 0 && (
        <div className="mt-2 ml-1 border-l border-border/40 pl-4 space-y-3">
          {milestone.children.map((child, i) => {
            if (child.type === "amendment") {
              return (
                <AmendmentItem
                  key={`amend-${child.sortDate}-${i}`}
                  child={child}
                />
              );
            }
            if (child.type === "vote") {
              return (
                <VoteItem
                  key={`vote-${child.chamber}-${i}`}
                  child={child}
                />
              );
            }
            // resource
            return <ResourceItem key={child.id} resource={child} />;
          })}
        </div>
      )}
    </div>
  );
}

// ── Main component ──────────────────────────────────────────────────────

interface UnifiedTimelineViewProps {
  timeline: UnifiedTimeline;
}

export function UnifiedTimelineView({ timeline }: UnifiedTimelineViewProps) {
  const { earlyCoverage, milestones, undatedResources } = timeline;
  const totalEvents =
    milestones.length +
    milestones.reduce((sum, m) => sum + m.children.length, 0);

  if (totalEvents === 0 && earlyCoverage.length === 0 && undatedResources.length === 0) return null;

  return (
    <div>
      {/* Early coverage (resources before first milestone) */}
      {earlyCoverage.length > 0 && (
        <div className="mb-6">
          <h3 className="text-sm font-semibold text-muted-foreground/70 uppercase tracking-wider mb-3">
            Early Coverage
          </h3>
          <div className="space-y-1 pl-2">
            {earlyCoverage.map((r) => (
              <ResourceItem key={r.id} resource={r} />
            ))}
          </div>
        </div>
      )}

      {/* Main timeline */}
      {milestones.length > 0 && (
        <div className="relative pl-7 border-l-2 border-border space-y-6">
          {milestones.map((milestone, i) => (
            <MilestoneEntry
              key={`${milestone.label}-${i}`}
              milestone={milestone}
            />
          ))}
        </div>
      )}

      {/* Undated resources */}
      {undatedResources.length > 0 && (
        <div className="mt-6">
          <h3 className="text-sm font-semibold text-muted-foreground/70 uppercase tracking-wider mb-3">
            Undated Resources
          </h3>
          <div className="space-y-1 pl-2">
            {undatedResources.map((r) => (
              <ResourceItem key={r.id} resource={r} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
