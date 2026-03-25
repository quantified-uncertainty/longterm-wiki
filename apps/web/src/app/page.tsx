import Link from "next/link";
import {
  getExploreItems,
  getAllPages,
  getAllPublications,
  getAllResources,
  getTypedEntities,
} from "@/data";
import { ContentCard } from "@/components/explore/ContentCard";
import {
  Search,
  Building2,
  Users,
  Brain,
  Landmark,
  Banknote,
  BookOpen,
  FlaskConical,
  CalendarDays,
  BarChart3,
  FileText,
  ExternalLink,
} from "lucide-react";
import type { ExploreItem } from "@/data";
import type { LucideIcon } from "lucide-react";

// ── Directory definitions ────────────────────────────────────────────
// Entity type strings are referenced from entity-type-names.ts canonical list.
// When multiple canonical types map to the same directory, list them in `entityTypes`.

interface DirectoryDef {
  /** Unique key for this directory (may be a canonical entity type or a pseudo-type like "_grant") */
  type: string;
  /** Canonical entity types that belong to this directory */
  entityTypes: string[];
  label: string;
  href: string;
  icon: LucideIcon;
  iconColor: string;
  /** Override count — e.g. for PG-primary tables not in ExploreItems */
  fixedCount?: number;
}

const DIRECTORIES: DirectoryDef[] = [
  { type: "organization", entityTypes: ["organization"], label: "Organizations", href: "/organizations", icon: Building2, iconColor: "text-slate-500" },
  { type: "person", entityTypes: ["person"], label: "People", href: "/people", icon: Users, iconColor: "text-blue-500" },
  { type: "ai-model", entityTypes: ["ai-model"], label: "AI Models", href: "/ai-models", icon: Brain, iconColor: "text-purple-500" },
  { type: "policy", entityTypes: ["policy"], label: "Legislation", href: "/legislation", icon: Landmark, iconColor: "text-amber-600" },
  { type: "approach", entityTypes: ["approach", "safety-agenda"], label: "Approaches", href: "/approaches", icon: FlaskConical, iconColor: "text-emerald-500" },
  { type: "event", entityTypes: ["event"], label: "Events", href: "/events", icon: CalendarDays, iconColor: "text-orange-500" },
  { type: "benchmark", entityTypes: ["benchmark"], label: "Benchmarks", href: "/benchmarks", icon: BarChart3, iconColor: "text-indigo-500" },
  { type: "_grant", entityTypes: [], label: "Grants", href: "/grants", icon: Banknote, iconColor: "text-green-500" },
  { type: "_publication", entityTypes: [], label: "Publications", href: "/publications", icon: BookOpen, iconColor: "text-rose-500" },
];

/** Set of all entity types that map to a directory, for fast lookups */
const DIRECTORY_ENTITY_TYPES = new Set(DIRECTORIES.flatMap((d) => d.entityTypes));

// ── Stats definitions ────────────────────────────────────────────────

interface StatDef {
  label: string;
  icon: LucideIcon;
  iconColor: string;
  getValue: (ctx: DataContext) => number;
  href: string;
}

interface DataContext {
  entityTypeCounts: Map<string, number>;
  totalPages: number;
  publicationCount: number;
  resourceCount: number;
}

/** Count entities matching the given directory's entityTypes */
function dirEntityCount(dir: DirectoryDef, ctx: DataContext): number {
  let total = 0;
  for (const t of dir.entityTypes) {
    total += ctx.entityTypeCounts.get(t) ?? 0;
  }
  return total;
}

const STAT_DEFS: StatDef[] = [
  {
    label: "Organizations",
    icon: Building2,
    iconColor: "text-slate-500",
    getValue: (ctx) => ctx.entityTypeCounts.get("organization") ?? 0,
    href: "/organizations",
  },
  {
    label: "People",
    icon: Users,
    iconColor: "text-blue-500",
    getValue: (ctx) => ctx.entityTypeCounts.get("person") ?? 0,
    href: "/people",
  },
  {
    label: "Publications",
    icon: BookOpen,
    iconColor: "text-rose-500",
    getValue: (ctx) => ctx.publicationCount,
    href: "/publications",
  },
  {
    label: "Approaches",
    icon: FlaskConical,
    iconColor: "text-emerald-500",
    getValue: (ctx) => (ctx.entityTypeCounts.get("approach") ?? 0) + (ctx.entityTypeCounts.get("safety-agenda") ?? 0),
    href: "/approaches",
  },
  {
    label: "Wiki pages",
    icon: FileText,
    iconColor: "text-slate-400",
    getValue: (ctx) => ctx.totalPages,
    href: "/wiki",
  },
  {
    label: "Resources",
    icon: ExternalLink,
    iconColor: "text-orange-500",
    getValue: (ctx) => ctx.resourceCount,
    href: "/resources",
  },
];

// ── Directory preview sections ───────────────────────────────────────
// Derive preview config from DIRECTORIES to avoid duplicating type strings.

interface PreviewSection {
  label: string;
  entityTypes: string[];
  href: string;
  icon: LucideIcon;
  iconColor: string;
  /** How many items to show */
  count: number;
}

/** Directory types to show in preview sections, with item count */
const PREVIEW_DIRECTORY_TYPES = ["organization", "person", "approach", "policy"] as const;

const PREVIEW_SECTIONS: PreviewSection[] = PREVIEW_DIRECTORY_TYPES.map((dirType) => {
  const dir = DIRECTORIES.find((d) => d.type === dirType)!;
  return {
    label: dir.label,
    entityTypes: dir.entityTypes,
    href: dir.href,
    icon: dir.icon,
    iconColor: dir.iconColor,
    count: 6,
  };
});

// ── Scoring ──────────────────────────────────────────────────────────

function entityScore(item: ExploreItem): number {
  const imp = item.readerImportance || 0;
  const qual = item.quality || 0;
  const facts = item.kbFactCount || 0;
  return imp * 3 + qual + facts * 2;
}

// ── Page component ───────────────────────────────────────────────────

export default function Home() {
  // Use entity-backed data for directory stats and previews (not getExploreItems
  // which includes pageOnlyItems — wiki pages without typed entities).
  const entities = getTypedEntities();
  const allItems = getExploreItems().filter(
    (item) => item.type !== "table" && item.type !== "diagram" && item.type !== "internal"
  );
  const pages = getAllPages();
  const publications = getAllPublications();
  const resources = getAllResources();

  const totalPages = pages.length;
  const publicationCount = publications.length;
  const resourceCount = resources.length;

  // Count typed entities by entityType for directory stats
  const entityTypeCounts = new Map<string, number>();
  for (const entity of entities) {
    const t = entity.entityType;
    entityTypeCounts.set(t, (entityTypeCounts.get(t) ?? 0) + 1);
  }

  const dataCtx: DataContext = { entityTypeCounts, totalPages, publicationCount, resourceCount };

  // Build directory chips with counts.
  // Compute synthetic/PG-primary counts BEFORE filtering so _publication isn't dropped.
  const directoryChips = DIRECTORIES.map((dir) => {
    const count =
      dir.type === "_grant"
        ? 0 // Grants are PG-primary — not in explore items; grants page has its own count
        : dir.type === "_publication"
          ? publicationCount
          : dir.fixedCount ?? dirEntityCount(dir, dataCtx);

    return { ...dir, count };
  }).filter((d) => d.count > 0 || d.type === "_grant");

  // Build preview sections — top entities per directory type (entity-backed only)
  const entityTypeSet = new Set(DIRECTORY_ENTITY_TYPES);
  const entityItems = allItems.filter((item) => entityTypeSet.has(item.type));
  const previewData = PREVIEW_SECTIONS.map((section) => {
    const typeSet = new Set(section.entityTypes);
    const items = entityItems
      .filter((item) => typeSet.has(item.type))
      .sort((a, b) => entityScore(b) - entityScore(a))
      .slice(0, section.count);
    return { ...section, items };
  }).filter((s) => s.items.length > 0);

  // Recently updated pages
  const recentlyUpdated = allItems
    .filter((item) => item.lastUpdated && (item.quality ?? 0) >= 40)
    .sort((a, b) => new Date(b.lastUpdated!).getTime() - new Date(a.lastUpdated!).getTime())
    .slice(0, 8);

  return (
    <div>
      {/* Hero */}
      <section className="relative overflow-hidden border-b border-border">
        <div className="absolute inset-0 bg-gradient-to-b from-slate-50 to-background dark:from-slate-950 dark:to-background" />
        <div className="relative max-w-7xl mx-auto px-6 pt-10 sm:pt-12 pb-10">
          <p className="text-base text-muted-foreground max-w-2xl mb-6 leading-relaxed">
            Structured data on organizations, people, models, legislation, grants,
            and publications — plus {totalPages} wiki articles on AI safety.
          </p>

          {/* Search bar */}
          <Link
            href="/search"
            className="flex items-center gap-3 max-w-xl px-4 py-3 rounded-xl border border-border bg-background/80 hover:bg-muted/50 transition-colors no-underline mb-7 group"
          >
            <Search size={18} className="text-muted-foreground/60 shrink-0" />
            <span className="text-sm text-muted-foreground/60 group-hover:text-muted-foreground transition-colors">
              Search organizations, people, models, grants...
            </span>
            <kbd className="hidden sm:inline-flex ml-auto items-center gap-0.5 text-[10px] text-muted-foreground/40 border border-border/60 rounded px-1.5 py-0.5 font-mono">
              &#x2318;K
            </kbd>
          </Link>

          {/* Directory chips */}
          <div className="flex flex-wrap gap-2 mb-8">
            {directoryChips.map((dir) => {
              const Icon = dir.icon;
              return (
                <Link
                  key={dir.type}
                  href={dir.href}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border/60 text-sm text-foreground hover:bg-muted/50 transition-colors no-underline bg-background/60"
                >
                  <Icon size={13} className={dir.iconColor} />
                  <span>{dir.label}</span>
                  {dir.count > 0 && (
                    <span className="text-xs text-muted-foreground/40 tabular-nums">{dir.count}</span>
                  )}
                </Link>
              );
            })}
            <Link
              href="/wiki"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border/60 text-sm text-foreground hover:bg-muted/50 transition-colors no-underline bg-background/60"
            >
              <FileText size={13} className="text-slate-400" />
              <span>Wiki pages</span>
              <span className="text-xs text-muted-foreground/40 tabular-nums">{totalPages}</span>
            </Link>
            <Link
              href="/resources"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-border/60 text-sm text-foreground hover:bg-muted/50 transition-colors no-underline bg-background/60"
            >
              <ExternalLink size={13} className="text-orange-500" />
              <span>Resources</span>
              <span className="text-xs text-muted-foreground/40 tabular-nums">{resourceCount}</span>
            </Link>
          </div>

          {/* Stats strip */}
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-px rounded-lg overflow-hidden border border-border bg-border">
            {STAT_DEFS.map((stat) => (
              <StatCard
                key={stat.label}
                value={stat.getValue(dataCtx)}
                label={stat.label}
                icon={stat.icon}
                color={stat.iconColor}
                href={stat.href}
              />
            ))}
          </div>
        </div>
      </section>

      <div className="max-w-7xl mx-auto px-6">
        {/* Directory previews */}
        <section className="py-10">
          <div className="flex items-center gap-4 mb-6">
            <h2 className="text-2xl font-semibold">Explore by type</h2>
            <div className="flex-1 h-px bg-border" />
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-10 gap-y-8">
            {previewData.map((section) => {
              const SectionIcon = section.icon;
              return (
                <div key={section.href}>
                  <div className="flex items-center gap-2 mb-2">
                    <SectionIcon className={`w-4 h-4 ${section.iconColor}`} />
                    <h3 className="text-sm font-semibold">{section.label}</h3>
                  </div>
                  <div className="space-y-0">
                    {section.items.map((item) => (
                      <Link
                        key={item.id}
                        href={item.href || `/wiki/${item.wikiId}`}
                        className="flex items-center justify-between py-2 border-b border-border/50 last:border-b-0 no-underline group"
                      >
                        <span className="text-sm text-foreground group-hover:text-accent-foreground truncate">
                          {item.title}
                        </span>
                      </Link>
                    ))}
                  </div>
                  <Link
                    href={section.href}
                    className="inline-block mt-2 text-xs text-muted-foreground hover:text-foreground no-underline transition-colors"
                  >
                    View all &rarr;
                  </Link>
                </div>
              );
            })}
          </div>
        </section>

        {/* Recently updated */}
        <section className="pb-12">
          <div className="flex items-center gap-4 mb-6">
            <h2 className="text-2xl font-semibold">Recently updated</h2>
            <div className="flex-1 h-px bg-border" />
            <Link
              href="/wiki"
              className="text-sm text-muted-foreground hover:text-foreground no-underline transition-colors flex-shrink-0"
            >
              View all &rarr;
            </Link>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
            {recentlyUpdated.map((item) => (
              <ContentCard key={item.id} item={item} />
            ))}
          </div>
        </section>

        {/* Footer */}
        <section className="pb-16">
          <div className="border-t border-border pt-8 text-center">
            <p className="text-sm text-muted-foreground">
              {totalPages} pages &middot; Continuously updated
            </p>
          </div>
        </section>
      </div>
    </div>
  );
}

// ── Sub-components ───────────────────────────────────────────────────

function StatCard({
  value,
  label,
  icon: Icon,
  color,
  href,
}: {
  value: number;
  label: string;
  icon: LucideIcon;
  color: string;
  href: string;
}) {
  return (
    <Link href={href} className="bg-card p-3 sm:p-4 no-underline hover:bg-muted/30 transition-colors">
      <div className="flex items-center gap-1.5">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <div className="text-xl sm:text-2xl font-bold text-foreground tabular-nums">{value.toLocaleString()}</div>
      </div>
      <div className="text-[11px] sm:text-xs text-muted-foreground mt-0.5">{label}</div>
    </Link>
  );
}
