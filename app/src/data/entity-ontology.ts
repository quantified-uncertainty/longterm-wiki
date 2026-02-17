/**
 * Canonical entity type ontology.
 * Display metadata (labels, icons, colors) for entity types.
 *
 * The canonical list of all valid entity type names lives in
 * ./entity-type-names.ts — this file provides the display layer on top.
 *
 * Lab-* types have been flattened into "organization" with orgType subtypes.
 * "researcher" has been renamed to "person".
 */
import { ENTITY_TYPE_ALIASES } from "./entity-type-names";
import {
  Bug,
  User,
  Scale,
  Cpu,
  Shield,
  Building2,
  FlaskConical,
  HelpCircle,
  Clock,
  BookOpen,
  GraduationCap,
  BarChart3,
  Rocket,
  ClipboardList,
  Route,
  Banknote,
  Microscope,
  Gauge,
  AlertTriangle,
  Lightbulb,
  Box,
  Activity,
  Compass,
  Package,
  Calendar,
  MessageSquare,
  Brain,
  FileText,
  LayoutList,
} from "lucide-react";

type LucideIcon = React.ForwardRefExoticComponent<
  React.SVGProps<SVGSVGElement> & { size?: number | string }
>;

export interface EntityTypeDefinition {
  label: string;
  icon: LucideIcon;
  iconColor: string;
  badgeColor: string;
  /** Hex color for the InfoBox header bar background */
  headerColor: string;
}

/**
 * Every known entity type with its display metadata.
 * - `label`: human-readable name
 * - `icon`: Lucide icon component
 * - `iconColor`: Tailwind classes for the icon (used in EntityTypeIcon / InfoBox)
 * - `badgeColor`: Tailwind classes for explore-page badges (bg + text, light + dark)
 */
export const ENTITY_TYPES: Record<string, EntityTypeDefinition> = {
  risk: {
    label: "Risk",
    icon: Bug,
    iconColor: "text-red-600 dark:text-red-400",
    badgeColor: "bg-red-100 text-red-800 dark:bg-red-900/30 dark:text-red-300",
    headerColor: "#dc2626",
  },
  "risk-factor": {
    label: "Risk Factor",
    icon: AlertTriangle,
    iconColor: "text-orange-600 dark:text-orange-400",
    badgeColor: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    headerColor: "#f97316",
  },
  capability: {
    label: "Capability",
    icon: Cpu,
    iconColor: "text-blue-600 dark:text-blue-400",
    badgeColor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    headerColor: "#0891b2",
  },
  "safety-agenda": {
    label: "Safety Agenda",
    icon: Shield,
    iconColor: "text-green-600 dark:text-green-400",
    badgeColor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    headerColor: "#7c3aed",
  },
  approach: {
    label: "Approach",
    icon: Compass,
    iconColor: "text-emerald-600 dark:text-emerald-400",
    badgeColor: "bg-green-100 text-green-800 dark:bg-green-900/30 dark:text-green-300",
    headerColor: "#0891b2",
  },
  project: {
    label: "Project",
    icon: Package,
    iconColor: "text-teal-600 dark:text-teal-400",
    badgeColor: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
    headerColor: "#0d9488",
  },
  policy: {
    label: "Policy",
    icon: Scale,
    iconColor: "text-violet-600 dark:text-violet-400",
    badgeColor: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    headerColor: "#0d9488",
  },
  organization: {
    label: "Organization",
    icon: Building2,
    iconColor: "text-slate-600 dark:text-slate-400",
    badgeColor: "bg-amber-100 text-amber-800 dark:bg-amber-900/30 dark:text-amber-300",
    headerColor: "#64748b",
  },
  crux: {
    label: "Crux",
    icon: HelpCircle,
    iconColor: "text-yellow-600 dark:text-yellow-400",
    badgeColor: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    headerColor: "#ea580c",
  },
  concept: {
    label: "Concept",
    icon: Lightbulb,
    iconColor: "text-amber-500 dark:text-amber-300",
    badgeColor: "bg-slate-100 text-slate-800 dark:bg-slate-900/30 dark:text-slate-300",
    headerColor: "#6366f1",
  },
  "case-study": {
    label: "Case Study",
    icon: ClipboardList,
    iconColor: "text-stone-600 dark:text-stone-400",
    badgeColor: "bg-stone-100 text-stone-800 dark:bg-stone-900/30 dark:text-stone-300",
    headerColor: "#78716c",
  },
  person: {
    label: "Person",
    icon: User,
    iconColor: "text-sky-600 dark:text-sky-400",
    badgeColor: "bg-sky-100 text-sky-800 dark:bg-sky-900/30 dark:text-sky-300",
    headerColor: "#475569",
  },
  scenario: {
    label: "Scenario",
    icon: Route,
    iconColor: "text-purple-600 dark:text-purple-400",
    badgeColor: "bg-purple-100 text-purple-800 dark:bg-purple-900/30 dark:text-purple-300",
    headerColor: "#7c3aed",
  },
  resource: {
    label: "Resource",
    icon: BookOpen,
    iconColor: "text-lime-600 dark:text-lime-400",
    badgeColor: "bg-lime-100 text-lime-800 dark:bg-lime-900/30 dark:text-lime-300",
    headerColor: "#65a30d",
  },
  funder: {
    label: "Funder",
    icon: Banknote,
    iconColor: "text-green-600 dark:text-green-400",
    badgeColor: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/30 dark:text-emerald-300",
    headerColor: "#16a34a",
  },
  historical: {
    label: "Historical",
    icon: Clock,
    iconColor: "text-amber-600 dark:text-amber-400",
    badgeColor: "bg-stone-100 text-stone-800 dark:bg-stone-900/30 dark:text-stone-300",
    headerColor: "#78716c",
  },
  analysis: {
    label: "Analysis",
    icon: BarChart3,
    iconColor: "text-rose-600 dark:text-rose-400",
    badgeColor: "bg-teal-100 text-teal-800 dark:bg-teal-900/30 dark:text-teal-300",
    headerColor: "#e11d48",
  },
  model: {
    label: "Model",
    icon: Box,
    iconColor: "text-indigo-600 dark:text-indigo-400",
    badgeColor: "bg-indigo-100 text-indigo-800 dark:bg-indigo-900/30 dark:text-indigo-300",
    headerColor: "#8b5cf6",
  },
  parameter: {
    label: "Parameter",
    icon: Gauge,
    iconColor: "text-fuchsia-600 dark:text-fuchsia-400",
    badgeColor: "bg-fuchsia-100 text-fuchsia-800 dark:bg-fuchsia-900/30 dark:text-fuchsia-300",
    headerColor: "#c026d3",
  },
  metric: {
    label: "Metric",
    icon: Activity,
    iconColor: "text-cyan-600 dark:text-cyan-400",
    badgeColor: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
    headerColor: "#0891b2",
  },
  argument: {
    label: "Argument",
    icon: Scale,
    iconColor: "text-pink-600 dark:text-pink-400",
    badgeColor: "bg-pink-100 text-pink-800 dark:bg-pink-900/30 dark:text-pink-300",
    headerColor: "#ec4899",
  },
  table: {
    label: "Table",
    icon: ClipboardList,
    iconColor: "text-cyan-600 dark:text-cyan-400",
    badgeColor: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900/30 dark:text-cyan-300",
    headerColor: "#0891b2",
  },
  diagram: {
    label: "Diagram",
    icon: Activity,
    iconColor: "text-violet-600 dark:text-violet-400",
    badgeColor: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
    headerColor: "#7c3aed",
  },
  insight: {
    label: "Insight",
    icon: Lightbulb,
    iconColor: "text-blue-600 dark:text-blue-400",
    badgeColor: "bg-blue-100 text-blue-800 dark:bg-blue-900/30 dark:text-blue-300",
    headerColor: "#3b82f6",
  },
  event: {
    label: "Event",
    icon: Calendar,
    iconColor: "text-rose-600 dark:text-rose-400",
    badgeColor: "bg-rose-100 text-rose-800 dark:bg-rose-900/30 dark:text-rose-300",
    headerColor: "#e11d48",
  },
  debate: {
    label: "Debate",
    icon: MessageSquare,
    iconColor: "text-orange-600 dark:text-orange-400",
    badgeColor: "bg-orange-100 text-orange-800 dark:bg-orange-900/30 dark:text-orange-300",
    headerColor: "#ea580c",
  },
  overview: {
    label: "Overview",
    icon: LayoutList,
    iconColor: "text-blue-600 dark:text-blue-400",
    badgeColor: "bg-blue-50 text-blue-700 dark:bg-blue-900/30 dark:text-blue-300",
    headerColor: "#3b82f6",
  },
  "intelligence-paradigm": {
    label: "Intelligence Paradigm",
    icon: Brain,
    iconColor: "text-violet-600 dark:text-violet-400",
    badgeColor: "bg-violet-100 text-violet-800 dark:bg-violet-900/30 dark:text-violet-300",
    headerColor: "#7c3aed",
  },
  internal: {
    label: "Internal",
    icon: FileText,
    iconColor: "text-slate-500 dark:text-slate-400",
    badgeColor: "bg-slate-100 text-slate-700 dark:bg-slate-800/30 dark:text-slate-300",
    headerColor: "#64748b",
  },
};

/**
 * Organization subtype display metadata.
 * When an entity is `entityType: "organization"` with a specific `orgType`,
 * use these to override the default organization icon/label.
 */
interface OrgTypeDefinition {
  label: string;
  icon: LucideIcon;
  iconColor: string;
  /** Hex color for the InfoBox header bar background */
  headerColor: string;
}

const ORG_TYPE_DISPLAY: Record<string, OrgTypeDefinition> = {
  "frontier-lab": { label: "Frontier Lab", icon: Rocket, iconColor: "text-orange-600 dark:text-orange-400", headerColor: "#dc2626" },
  "safety-org": { label: "Safety Org", icon: Microscope, iconColor: "text-teal-600 dark:text-teal-400", headerColor: "#0d9488" },
  academic: { label: "Academic", icon: GraduationCap, iconColor: "text-indigo-600 dark:text-indigo-400", headerColor: "#059669" },
  startup: { label: "Startup", icon: Rocket, iconColor: "text-pink-600 dark:text-pink-400", headerColor: "#7c3aed" },
  generic: { label: "Lab", icon: FlaskConical, iconColor: "text-cyan-600 dark:text-cyan-400", headerColor: "#0891b2" },
  funder: { label: "Funder", icon: Banknote, iconColor: "text-green-600 dark:text-green-400", headerColor: "#16a34a" },
  government: { label: "Government", icon: Building2, iconColor: "text-slate-600 dark:text-slate-400", headerColor: "#475569" },
};

// Backward compat: merge alias entries so lookups like ENTITY_TYPES["researcher"]
// resolve to the canonical type's display definition.
// Alias → canonical mappings are defined in entity-type-names.ts.
for (const [alias, canonical] of Object.entries(ENTITY_TYPE_ALIASES)) {
  if (!ENTITY_TYPES[alias] && ENTITY_TYPES[canonical]) {
    ENTITY_TYPES[alias] = ENTITY_TYPES[canonical];
  }
}

const DEFAULT_BADGE_COLOR = "bg-gray-100 text-gray-800 dark:bg-gray-900/30 dark:text-gray-300";

// ---------------------------------------------------------------------------
// Explore page semantic groupings
// ---------------------------------------------------------------------------

export const ENTITY_GROUPS: { label: string; types: string[] }[] = [
  { label: "All", types: [] },
  { label: "Risks", types: ["risk", "risk-factor"] },
  { label: "Responses", types: ["approach", "safety-agenda", "policy"] },
  { label: "Projects", types: ["project"] },
  { label: "Organizations", types: ["organization"] },
  { label: "People", types: ["person"] },
  { label: "Capabilities", types: ["capability"] },
  { label: "Models", types: ["model"] },
  { label: "Concepts", types: ["concept", "crux", "argument", "analysis", "historical"] },
  { label: "Overviews", types: ["overview"] },
  { label: "Tables", types: ["table"] },
  { label: "Diagrams", types: ["diagram"] },
  { label: "Internal", types: ["internal"] },
];

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function getEntityType(type: string): EntityTypeDefinition | undefined {
  return ENTITY_TYPES[type];
}

export function getEntityTypeLabel(type: string): string {
  return ENTITY_TYPES[type]?.label ?? type;
}

export function getEntityTypeIcon(type: string): LucideIcon | null {
  return ENTITY_TYPES[type]?.icon ?? null;
}

export function getEntityTypeBadgeColor(type: string): string {
  return ENTITY_TYPES[type]?.badgeColor ?? DEFAULT_BADGE_COLOR;
}

const DEFAULT_HEADER_COLOR = "#6b7280";

/**
 * Get the InfoBox header display info for an entity type, with optional orgType override.
 * Returns { label, headerColor } for use in the InfoBox header bar.
 */
export function getEntityTypeHeader(
  type: string,
  orgType?: string,
): { label: string; headerColor: string } {
  if (type === "organization" && orgType && ORG_TYPE_DISPLAY[orgType]) {
    const org = ORG_TYPE_DISPLAY[orgType];
    return { label: org.label, headerColor: org.headerColor };
  }
  const def = ENTITY_TYPES[type];
  return {
    label: def?.label ?? "Entry",
    headerColor: def?.headerColor ?? DEFAULT_HEADER_COLOR,
  };
}

/**
 * Get the display label for an organization subtype.
 */
export function getOrgTypeLabel(orgType: string): string {
  return ORG_TYPE_DISPLAY[orgType]?.label ?? orgType;
}
