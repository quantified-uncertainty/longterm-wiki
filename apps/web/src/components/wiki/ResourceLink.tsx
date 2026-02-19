import React from "react";
import { getResourceById, getResourceCredibility, getResourcePublication } from "@data";
import { CredibilityBadge } from "./CredibilityBadge";
import { ResourceTags } from "./ResourceTags";
import { cn } from "@lib/utils";
import styles from "./tooltip.module.css";

const typeIcons: Record<string, string> = {
  paper: "\ud83d\udcc4",
  book: "\ud83d\udcda",
  blog: "\u270f\ufe0f",
  report: "\ud83d\udccb",
  talk: "\ud83c\udf99\ufe0f",
  podcast: "\ud83c\udfa7",
  government: "\ud83c\udfdb\ufe0f",
  reference: "\ud83d\udcd6",
  web: "\ud83d\udd17",
};

function getResourceTypeIcon(type: string): string {
  return typeIcons[type] || "\ud83d\udd17";
}

function truncateText(text: string | undefined | null, maxLength: number): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

export function ResourceLink({
  id,
  label,
  children,
  showType = false,
  showCredibility = false,
  className = "",
}: {
  id: string;
  label?: string;
  children?: React.ReactNode;
  showType?: boolean;
  showCredibility?: boolean;
  className?: string;
}) {
  const resource = getResourceById(id);

  if (!resource) {
    return (
      <span className={cn("text-destructive italic", className)} title={`Resource not found: ${id}`}>
        [{id}]
      </span>
    );
  }

  const displayLabel = children || label || resource.title;
  const icon = showType ? getResourceTypeIcon(resource.type) : null;
  const credibility = getResourceCredibility(resource);
  const publication = getResourcePublication(resource);

  return (
    <span className={styles.wrapper}>
      <a
        href={resource.url}
        target="_blank"
        rel="noopener noreferrer"
        className={cn("text-accent-foreground no-underline font-medium hover:underline", className)}
      >
        {icon && <span className="mr-1">{icon}</span>}
        <span>{displayLabel}</span>
        {showCredibility && credibility && (
          <span className="ml-1">
            <CredibilityBadge level={credibility} size="sm" />
          </span>
        )}
        <span className="text-xs ml-0.5 opacity-70">{"\u2197"}</span>
      </a>
      <span
        className={cn(
          styles.tooltip,
          "absolute left-0 top-full mt-1 z-50 w-[280px] p-2.5 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible text-[0.8rem] leading-snug"
        )}
        role="tooltip"
      >
        <span className="flex justify-between items-center mb-2">
          <span className="text-[0.7rem] uppercase tracking-tight text-muted-foreground">
            {getResourceTypeIcon(resource.type)} {resource.type}
          </span>
          {credibility && <CredibilityBadge level={credibility} size="sm" />}
        </span>

        {publication && (
          <span className="text-[10px] text-muted-foreground italic mb-1 block">
            {publication.name}
            {publication.peer_reviewed && " (peer-reviewed)"}
          </span>
        )}

        <span className="block font-semibold text-foreground mb-1.5">{resource.title}</span>

        {resource.authors && resource.authors.length > 0 && (
          <span className="block text-[0.8rem] text-muted-foreground mb-1.5">
            {resource.authors.slice(0, 3).join(", ")}
            {resource.authors.length > 3 && " et al."}
            {resource.published_date && ` (${resource.published_date.slice(0, 4)})`}
          </span>
        )}

        {resource.summary && (
          <span className="block text-[0.8rem] text-muted-foreground mb-2.5 leading-snug">
            {truncateText(resource.summary, 180)}
          </span>
        )}

        {resource.tags && resource.tags.length > 0 && (
          <span className="mt-1.5 block">
            <ResourceTags tags={resource.tags} limit={4} size="sm" />
          </span>
        )}

        <span className="flex gap-2 mt-2 pointer-events-auto">
          <a
            href={resource.url}
            className="flex-1 px-2.5 py-1.5 text-xs font-medium text-center no-underline rounded transition-colors bg-accent-foreground text-background hover:bg-accent-foreground/90"
            target="_blank"
            rel="noopener noreferrer"
          >
            Source {"\u2197"}
          </a>
        </span>
      </span>
    </span>
  );
}

export { ResourceLink as R };
export default ResourceLink;
