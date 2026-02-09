import { ENTITY_TYPES, getEntityType } from "@/data/entity-ontology";
import type { EntityTypeDefinition } from "@/data/entity-ontology";
import { cn } from "@lib/utils";

type LucideIcon = React.ForwardRefExoticComponent<
  React.SVGProps<SVGSVGElement> & { size?: number | string }
>;

export type EntityType =
  | "risk"
  | "risk-factor"
  | "capability"
  | "safety-agenda"
  | "approach"
  | "project"
  | "policy"
  | "organization"
  | "crux"
  | "concept"
  | "case-study"
  | "person"
  | "scenario"
  | "resource"
  | "funder"
  | "historical"
  | "analysis"
  | "model"
  | "parameter"
  | "metric"
  | "argument"
  // Backward compat aliases (resolved via ENTITY_TYPES lookup)
  | "researcher"
  | "lab"
  | "lab-frontier"
  | "lab-research"
  | "lab-startup"
  | "lab-academic";

interface EntityTypeConfig {
  icon: LucideIcon;
  label: string;
  color: string;
}

// Backward-compatible re-export: maps iconColor → color for consumers like InfoBox
export const entityTypeConfig: Record<EntityType, EntityTypeConfig> = Object.fromEntries(
  Object.entries(ENTITY_TYPES)
    .filter(([key]) => key as EntityType)
    .map(([key, def]: [string, EntityTypeDefinition]) => [
      key,
      { icon: def.icon, label: def.label, color: def.iconColor },
    ])
) as Record<EntityType, EntityTypeConfig>;

const sizeClasses = {
  xs: "w-3 h-3",
  sm: "w-4 h-4",
  md: "w-5 h-5",
  lg: "w-6 h-6",
};

export function EntityTypeIcon({
  type,
  size = "md",
  showLabel = false,
  className,
}: {
  type: EntityType | string;
  size?: "xs" | "sm" | "md" | "lg";
  showLabel?: boolean;
  className?: string;
}) {
  const def = getEntityType(type);
  if (!def) {
    return showLabel ? <span className="text-muted-foreground">{type}</span> : null;
  }
  const Icon = def.icon;
  return (
    <span className={cn("inline-flex items-center gap-1.5", className)}>
      <Icon className={cn(sizeClasses[size], def.iconColor)} />
      {showLabel && <span className={cn("text-sm font-medium", def.iconColor)}>{def.label}</span>}
    </span>
  );
}

export function getEntityTypeIcon(type: EntityType | string): LucideIcon | null {
  const def = getEntityType(type);
  return def?.icon || null;
}

export function getEntityTypeLabel(type: EntityType | string): string {
  const def = getEntityType(type);
  return def?.label || type;
}

export default EntityTypeIcon;
