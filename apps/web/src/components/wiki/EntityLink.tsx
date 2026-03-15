import React from "react";
import Link from "next/link";
import { getEntityById, getEntityHref, getPageById, getDirectoryHref } from "@data";
import { getEntityTypeIcon } from "./EntityTypeIcon";
import { cn } from "@lib/utils";
import styles from "./tooltip.module.css";

interface EntityLinkProps {
  id: string;
  /** Optional cross-check: entity slug that id should resolve to. Validated at build time. */
  name?: string;
  label?: string;
  children?: React.ReactNode;
  showIcon?: boolean;
  className?: string;
  external?: boolean;
}

function truncateText(text: string | undefined | null, maxLength: number): string {
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + "...";
}

function formatEntityType(type: string): string {
  return type
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function formatIdAsTitle(id: string): string {
  return id
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export function EntityLink({
  id,
  name: _name,
  label,
  children,
  showIcon = false,
  className = "",
  external = false,
}: EntityLinkProps) {
  const entity = getEntityById(id);
  const page = getPageById(id);

  const href = getEntityHref(id, entity?.type);
  // Check if a reachable page exists (either a directory page or a wiki page with MDX content)
  const hasReachablePage = !!getDirectoryHref(id) || !!page;

  const displayLabel = children || label || entity?.title || formatIdAsTitle(id);
  const IconComponent = showIcon && entity ? getEntityTypeIcon(entity.type) : null;
  const externalProps = external
    ? { target: "_blank" as const, rel: "noopener noreferrer" }
    : {};

  const summary = page?.llmSummary || page?.description || entity?.description;
  const entityType = entity?.type;
  const TypeIconComponent = entity ? getEntityTypeIcon(entity.type) : null;

  // If no reachable page exists, render as plain styled text (no link)
  if (!hasReachablePage) {
    return (
      <span
        className={cn(
          "inline-flex items-center gap-1 px-2 py-0.5 bg-muted/50 rounded text-sm text-muted-foreground",
          className
        )}
        title={entity?.title || formatIdAsTitle(id)}
      >
        {IconComponent && <IconComponent className="w-3 h-3" />}
        <span>{displayLabel}</span>
      </span>
    );
  }

  if (summary || entityType) {
    return (
      <span className={styles.wrapper}>
        <Link
          href={href}
          className={cn(
            "inline-flex items-center gap-1 px-2 py-0.5 bg-muted rounded text-sm text-accent-foreground no-underline transition-colors hover:bg-muted/80",
            className
          )}
          {...externalProps}
        >
          {IconComponent && <IconComponent className="w-3 h-3" />}
          <span>{displayLabel}</span>
        </Link>
        <span
          className={cn(
            styles.tooltip,
            "absolute top-full mt-1 z-50 w-[280px] p-3 bg-popover text-popover-foreground border rounded-md shadow-md pointer-events-none opacity-0 invisible",
            styles.tooltipPositioned
          )}
          role="tooltip"
          aria-hidden="true"
        >
          {entityType && (
            <span className="flex items-center gap-1.5 mb-2 text-xs text-muted-foreground">
              {TypeIconComponent && <TypeIconComponent className="w-3 h-3" />}
              <span className="uppercase tracking-wide">{formatEntityType(entityType)}</span>
            </span>
          )}
          <span className="block font-semibold text-foreground mb-1.5 text-sm">
            {entity?.title || formatIdAsTitle(id)}
          </span>
          {summary && (
            <span className="block text-muted-foreground text-[0.8rem] leading-snug">
              {truncateText(summary, 200)}
            </span>
          )}
          {page?.quality && (
            <span className="block mt-2 text-xs text-muted-foreground">
              Quality: {page.quality}/100
            </span>
          )}
        </span>
      </span>
    );
  }

  return (
    <Link
      href={href}
      className={cn(
        "inline-flex items-center gap-1 px-2 py-0.5 bg-muted rounded text-sm text-accent-foreground no-underline transition-colors hover:bg-muted/80",
        className
      )}
      {...externalProps}
    >
      {IconComponent && <IconComponent className="w-3 h-3" />}
      <span>{displayLabel}</span>
    </Link>
  );
}

export function MultiEntityLinks({
  ids,
  showIcons = false,
  className = "",
}: {
  ids: string[];
  showIcons?: boolean;
  className?: string;
}) {
  return (
    <span className={cn("inline-flex flex-wrap gap-1", className)}>
      {ids.map((id, index) => (
        <React.Fragment key={id}>
          <EntityLink id={id} showIcon={showIcons} />
          {index < ids.length - 1 && ", "}
        </React.Fragment>
      ))}
    </span>
  );
}

export default EntityLink;
