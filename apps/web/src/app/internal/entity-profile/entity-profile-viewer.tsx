"use client";

import { useState, useCallback, useMemo, useEffect, useRef } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Search,
  ChevronDown,
  ChevronRight,
  Database,
  Layers,
  ExternalLink,
  Loader2,
  TableProperties,
  ShieldCheck,
} from "lucide-react";
import Link from "next/link";
import * as HoverCard from "@radix-ui/react-hover-card";
import { SourceCheckDot } from "@/components/verification/SourceCheckDot";
import { recordVerdictToStatus } from "@/components/verification/source-check-status";

import { formatCompactCurrency, formatCompactNumber } from "@/lib/format-compact";
import { isAnySid } from "@longterm-wiki/id-utils";

// ── Types ──────────────────────────────────────────────────────────────────

interface ColumnMeta {
  name: string;
  dataType: string;
  columnType: string;
  notNull: boolean;
  hasDefault: boolean;
  description?: string;
}

interface Section {
  key: string;
  label: string;
  description: string;
  schema: { columns: ColumnMeta[] };
  rows: Record<string, unknown>[];
  total: number;
  error?: string;
  recordType?: string;
}

interface DisplayNameEntry {
  title: string;
  slug: string;
  entityType: string;
}

interface DisplayNameEntry {
  title: string;
  slug: string;
  entityType: string;
}

interface EntityProfileData {
  entity: Record<string, unknown>;
  sections: Section[];
  verdicts: Record<string, { verdict: string; confidence: number | null }>;
  displayNames: Record<string, DisplayNameEntry>;
}

// ── Entity search ──────────────────────────────────────────────────────────

function EntitySearch({
  initialQuery,
  onSearch,
  isLoading,
}: {
  initialQuery: string;
  onSearch: (q: string) => void;
  isLoading: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);

  // Sync input with URL param changes (e.g., browser back/forward, example entity clicks)
  useEffect(() => {
    if (initialQuery !== query) {
      setQuery(initialQuery);
    }
  // Only re-sync when the external prop changes, not when the user types
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialQuery]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (query.trim()) onSearch(query.trim());
  };

  return (
    <form onSubmit={handleSubmit} className="flex gap-2 items-center mb-6">
      <div className="relative flex-1">
        {isLoading ? (
          <Loader2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground animate-spin" />
        ) : (
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Entity slug, stableId, or numericId (e.g. anthropic, E42)"
          className="w-full h-10 pl-10 pr-4 border rounded-lg bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring transition-shadow"
        />
      </div>
      <button
        type="submit"
        disabled={isLoading || !query.trim()}
        className="h-10 px-5 bg-primary text-primary-foreground rounded-lg text-sm font-medium disabled:opacity-40 transition-opacity"
      >
        Look up
      </button>
    </form>
  );
}

// ── Type badge ─────────────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, string> = {
  string: "bg-sky-50 text-sky-700 dark:bg-sky-950/40 dark:text-sky-300",
  number: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  boolean: "bg-violet-50 text-violet-700 dark:bg-violet-950/40 dark:text-violet-300",
  date: "bg-amber-50 text-amber-700 dark:bg-amber-950/40 dark:text-amber-300",
  json: "bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300",
  bigint: "bg-emerald-50 text-emerald-700 dark:bg-emerald-950/40 dark:text-emerald-300",
  array: "bg-orange-50 text-orange-700 dark:bg-orange-950/40 dark:text-orange-300",
};

function TypeBadge({ dataType }: { dataType: string }) {
  const cls = TYPE_COLORS[dataType] ?? "bg-muted text-muted-foreground";
  return (
    <span className={`inline-block px-1.5 py-px rounded text-[10px] font-medium leading-tight ${cls}`}>
      {dataType}
    </span>
  );
}

// ── Entity type to directory mapping (client-side, for building links) ─────

const ENTITY_TYPE_DIRECTORY: Record<string, string> = {
  person: "/people",
  organization: "/organizations",
  benchmark: "/benchmarks",
  "ai-model": "/ai-models",
  policy: "/legislation",
  project: "/projects",
  "research-area": "/research-areas",
  approach: "/approaches",
  event: "/events",
  "political-race": "/races",
};

function entityHref(entry: DisplayNameEntry): string {
  const prefix = ENTITY_TYPE_DIRECTORY[entry.entityType];
  return prefix ? `${prefix}/${entry.slug}` : `/wiki/E1929?entity=${encodeURIComponent(entry.slug)}`;
}

// ── Column configuration per section ──────────────────────────────────────

/** Columns to hide per section (redundant legacy or consumed by entity ref rendering) */
const HIDDEN_COLUMNS: Record<string, Set<string>> = {
  personnel: new Set(["person_id", "organization_id", "person_display_name", "org_display_name"]),
  grantsGiven: new Set(["organization_id", "grantee_id", "org_display_name", "grantee_display_name"]),
  grantsReceived: new Set(["organization_id", "grantee_id", "org_display_name", "grantee_display_name"]),
  investments: new Set(["company_id", "investor_id", "company_display_name", "investor_display_name", "amount_low", "amount_high", "stake_low", "stake_high"]),
  equityPositions: new Set(["company_id", "holder_id", "company_display_name", "holder_display_name", "stake_low", "stake_high"]),
  fundingRounds: new Set(["company_id", "company_display_name", "lead_investor", "lead_investor_display_name", "raised_low", "raised_high", "valuation_low", "valuation_high"]),
  policyStakeholders: new Set(["stakeholder_display_name"]),
  divisionPersonnel: new Set(["person_display_name"]),
};

/** Human-readable header overrides for entity reference columns */
const COLUMN_HEADER_OVERRIDES: Record<string, string> = {
  person_entity_id: "Person",
  org_entity_id: "Organization",
  grantee_entity_id: "Grantee",
  company_entity_id: "Company",
  investor_entity_id: "Investor",
  holder_entity_id: "Holder",
  lead_investor_entity_id: "Lead Investor",
  stakeholder_entity_id: "Stakeholder",
  policy_entity_id: "Policy",
  entity_id: "Entity",
  parent_org_id: "Parent Org",
  person_id: "Person",
  organization_id: "Organization",
};

// ── Entity ref hover card ──────────────────────────────────────────────────

function EntityRefHoverCard({
  entry,
  stableId,
  children,
}: {
  entry: DisplayNameEntry;
  stableId: string;
  children: React.ReactNode;
}) {
  return (
    <HoverCard.Root openDelay={300} closeDelay={150}>
      <HoverCard.Trigger asChild>{children}</HoverCard.Trigger>
      <HoverCard.Portal>
        <HoverCard.Content
          className="z-50 w-[260px] rounded-lg border border-border bg-popover p-3 shadow-lg animate-in fade-in-0 zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=top]:slide-in-from-bottom-2"
          side="bottom"
          align="start"
          sideOffset={4}
        >
          <div className="flex items-center gap-1.5 mb-1.5">
            <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium bg-muted/50 px-1.5 py-0.5 rounded">
              {entry.entityType}
            </span>
          </div>
          <div className="font-semibold text-sm mb-1">{entry.title}</div>
          <div className="text-[10px] text-muted-foreground/60 font-mono mb-2">{stableId}</div>
          <Link
            href={entityHref(entry)}
            className="text-[11px] text-blue-600 dark:text-blue-400 hover:underline font-medium"
          >
            View entity →
          </Link>
          <HoverCard.Arrow className="fill-border" />
        </HoverCard.Content>
      </HoverCard.Portal>
    </HoverCard.Root>
  );
}

// ── Section grouping & entity-type filtering ──────────────────────────────

const SECTION_GROUPS: { label: string; keys: string[] }[] = [
  { label: "Core Data", keys: ["personnel", "divisions", "divisionPersonnel"] },
  { label: "Financial", keys: ["grantsGiven", "grantsReceived", "fundingRounds", "investments", "equityPositions", "fundingPrograms"] },
  { label: "Knowledge", keys: ["facts", "wikiPages", "things", "recommendedResources"] },
  { label: "Policy & Research", keys: ["policyStakeholders", "researchAreaOrganizations", "benchmarkResults"] },
];

/** Sections to EXCLUDE per entity type. Default: show all. */
const SECTIONS_EXCLUDE: Record<string, Set<string>> = {
  "ai-model": new Set(["personnel", "divisions", "divisionPersonnel", "grantsGiven", "grantsReceived", "fundingRounds", "investments", "equityPositions", "fundingPrograms", "policyStakeholders"]),
  benchmark: new Set(["personnel", "divisions", "divisionPersonnel", "grantsGiven", "grantsReceived", "fundingRounds", "investments", "equityPositions", "fundingPrograms", "policyStakeholders"]),
  person: new Set(["divisions", "divisionPersonnel", "grantsGiven", "fundingRounds", "fundingPrograms", "researchAreaOrganizations", "benchmarkResults"]),
  policy: new Set(["divisions", "divisionPersonnel", "fundingRounds", "investments", "equityPositions", "fundingPrograms", "researchAreaOrganizations", "benchmarkResults"]),
  project: new Set(["divisions", "divisionPersonnel", "fundingRounds", "investments", "equityPositions", "fundingPrograms", "benchmarkResults"]),
  approach: new Set(["personnel", "divisions", "divisionPersonnel", "grantsGiven", "grantsReceived", "fundingRounds", "investments", "equityPositions", "fundingPrograms", "benchmarkResults"]),
  concept: new Set(["personnel", "divisions", "divisionPersonnel", "grantsGiven", "grantsReceived", "fundingRounds", "investments", "equityPositions", "fundingPrograms", "benchmarkResults"]),
  risk: new Set(["personnel", "divisions", "divisionPersonnel", "grantsGiven", "grantsReceived", "fundingRounds", "investments", "equityPositions", "fundingPrograms", "benchmarkResults"]),
  event: new Set(["divisions", "divisionPersonnel", "fundingRounds", "investments", "equityPositions", "fundingPrograms", "benchmarkResults"]),
};

/** Global columns to hide from all sections */
const GLOBAL_HIDDEN_COLUMNS = new Set(["id"]);

/** Max rows to show initially before "Show all" */
const INITIAL_ROW_LIMIT = 20;

// ── Numeric formatting columns ────────────────────────────────────────────

/** Columns representing monetary amounts (Drizzle returns numeric() as strings) */
const CURRENCY_COLUMNS = new Set([
  "amount", "raised", "raised_low", "raised_high",
  "valuation", "valuation_low", "valuation_high",
  "amount_low", "amount_high", "total_budget",
  "usd_equivalent", "cost_usd",
]);

/** Columns representing 0-1 decimal fractions displayed as percentages */
const PERCENTAGE_COLUMNS = new Set([
  "stake_low", "stake_high",
]);

function formatPercentage(n: number): string {
  // Values > 1 are likely already percentages (e.g., 15 = 15%), not decimals
  const pct = Math.abs(n) > 1 ? n : n * 100;
  return `${pct.toFixed(1).replace(/\.0$/, "")}%`;
}

/** Try to parse a value as a number. Returns null if not parseable or is a range string like "[0.07, 0.15]". */
function tryParseNumeric(value: unknown): number | null {
  if (typeof value === "number") return isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed || trimmed.startsWith("[") || trimmed.startsWith("{")) return null;
  const n = Number(trimmed);
  return isFinite(n) ? n : null;
}

// ── Expandable text ───────────────────────────────────────────────────────

function ExpandableText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div>
      <span
        className={`text-[11px] whitespace-pre-wrap break-words ${expanded ? "" : "line-clamp-2"}`}
      >
        {text}
      </span>
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline ml-1"
      >
        {expanded ? "less" : "more"}
      </button>
    </div>
  );
}

// ── Cell renderer ──────────────────────────────────────────────────────────

function CellValue({
  value,
  columnName,
  displayNames,
  row,
}: {
  value: unknown;
  columnName: string;
  displayNames?: Record<string, DisplayNameEntry>;
  row?: Record<string, unknown>;
}) {
  if (value === null || value === undefined) {
    return <span className="text-muted-foreground/30 select-none">&mdash;</span>;
  }

  if (typeof value === "boolean") {
    return value ? (
      <span className="text-emerald-600 dark:text-emerald-400 font-medium">yes</span>
    ) : (
      <span className="text-muted-foreground/50">no</span>
    );
  }

  if (typeof value === "object") {
    return <JsonValue value={value} />;
  }

  // Entity reference columns -> show resolved name as link
  const isEntityRef =
    columnName.endsWith("EntityId") ||
    columnName.endsWith("_entity_id") ||
    columnName === "stableId" ||
    columnName === "stable_id" ||
    columnName === "parentOrgId" ||
    columnName === "parent_org_id";

  if (isEntityRef && typeof value === "string" && isAnySid(value)) {
    const resolved = displayNames?.[value];
    if (resolved) {
      return (
        <EntityRefHoverCard entry={resolved} stableId={value}>
          <Link
            href={entityHref(resolved)}
            className="text-blue-600 dark:text-blue-400 hover:underline text-xs"
          >
            {resolved.title}
          </Link>
        </EntityRefHoverCard>
      );
    }
    // Fallback: show stableId as link to DB profile
    return (
      <Link
        href={`/wiki/E1929?entity=${encodeURIComponent(value)}`}
        className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline font-mono text-[11px]"
        title="View entity DB profile"
      >
        {value}
        <ExternalLink className="h-2.5 w-2.5 opacity-40" />
      </Link>
    );
  }

  // Currency columns -> formatted compact currency
  if (CURRENCY_COLUMNS.has(columnName)) {
    const n = tryParseNumeric(value);
    if (n !== null) {
      const currency = (row?.currency as string) ?? undefined;
      return (
        <span className="text-[11px] tabular-nums font-medium whitespace-nowrap" title={String(value)}>
          {formatCompactCurrency(n, currency)}
        </span>
      );
    }
  }

  // Percentage columns -> formatted as X.X%
  if (PERCENTAGE_COLUMNS.has(columnName)) {
    const n = tryParseNumeric(value);
    if (n !== null) {
      return (
        <span className="text-[11px] tabular-nums font-medium" title={String(value)}>
          {formatPercentage(n)}
        </span>
      );
    }
  }

  // Generic number values (real/doublePrecision columns arrive as typeof number)
  if (typeof value === "number" && isFinite(value)) {
    const formatted = Math.abs(value) >= 1000
      ? formatCompactNumber(value)
      : Number.isInteger(value) ? value.toLocaleString() : value.toFixed(2);
    return (
      <span className="text-[11px] tabular-nums" title={String(value)}>
        {formatted}
      </span>
    );
  }

  // URL values
  if (typeof value === "string" && (value.startsWith("http://") || value.startsWith("https://"))) {
    const domain = (() => {
      try { return new URL(value).hostname.replace(/^www\./, ""); } catch { return null; }
    })();
    return (
      <a
        href={value}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400 hover:underline text-[11px] break-all"
      >
        {domain ?? (value.length > 50 ? value.slice(0, 50) + "\u2026" : value)}
        <ExternalLink className="h-2.5 w-2.5 opacity-40 shrink-0" />
      </a>
    );
  }

  const str = String(value);

  // Long text -> expandable with line-clamp
  if (str.length > 80) {
    // Check if it's stringified JSON — delegate to JsonValue if so
    if (str.startsWith("[") || str.startsWith("{")) {
      try {
        const parsed = JSON.parse(str);
        if (typeof parsed === "object" && parsed !== null) {
          return <JsonValue value={parsed} />;
        }
      } catch { /* not JSON, fall through */ }
    }
    return <ExpandableText text={str} />;
  }

  return <span className="text-[11px]">{str}</span>;
}

function JsonValue({ value }: { value: unknown }) {
  const [expanded, setExpanded] = useState(false);
  const json = JSON.stringify(value, null, 2);
  const isShort = json.length < 100;

  if (isShort) {
    return (
      <code className="text-[10px] font-mono bg-muted/80 px-1.5 py-0.5 rounded break-all leading-relaxed">
        {json}
      </code>
    );
  }

  return (
    <div>
      <button
        onClick={() => setExpanded(!expanded)}
        className="text-[10px] text-blue-600 dark:text-blue-400 hover:underline inline-flex items-center gap-0.5"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3" />
        ) : (
          <ChevronRight className="h-3 w-3" />
        )}
        {expanded ? "collapse" : `JSON \u00b7 ${json.length} chars`}
      </button>
      {expanded && (
        <pre className="text-[10px] font-mono bg-muted/80 p-2.5 rounded-md mt-1.5 overflow-x-auto max-h-64 leading-relaxed border border-border/40">
          {json}
        </pre>
      )}
    </div>
  );
}

// ── Section component ──────────────────────────────────────────────────────

function ProfileSection({
  section,
  verdicts,
  displayNames,
  defaultExpanded,
}: {
  section: Section;
  verdicts: Record<string, { verdict: string; confidence: number | null }>;
  displayNames: Record<string, DisplayNameEntry>;
  defaultExpanded: boolean;
}) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [showSchema, setShowSchema] = useState(false);
  const [showAllRows, setShowAllRows] = useState(false);

  const isEmpty = section.total === 0;

  // Filter out hidden/redundant columns (per-section + global)
  const visibleColumns = useMemo(() => {
    const hidden = HIDDEN_COLUMNS[section.key];
    return section.schema.columns.filter((col) =>
      !GLOBAL_HIDDEN_COLUMNS.has(col.name) && (!hidden || !hidden.has(col.name))
    );
  }, [section.key, section.schema.columns]);

  // Pagination: show first N rows unless expanded
  const displayedRows = useMemo(() => {
    if (showAllRows || section.rows.length <= INITIAL_ROW_LIMIT) return section.rows;
    return section.rows.slice(0, INITIAL_ROW_LIMIT);
  }, [section.rows, showAllRows]);

  // Source-check summary for sections with verdicts
  const verdictSummary = useMemo(() => {
    if (!section.recordType) return null;
    let checked = 0;
    let confirmed = 0;
    let contradicted = 0;
    let outdated = 0;
    for (const row of section.rows) {
      const id = row.id as string | undefined;
      if (id && verdicts[id]) {
        checked++;
        const v = verdicts[id].verdict;
        if (v === "confirmed") confirmed++;
        else if (v === "contradicted") contradicted++;
        else if (v === "outdated" || v === "partial") outdated++;
      }
    }
    if (checked === 0) return null;
    return { checked, total: section.rows.length, confirmed, contradicted, outdated };
  }, [section.rows, section.recordType, verdicts]);

  return (
    <div
      className={`border rounded-lg overflow-hidden transition-colors ${
        isEmpty
          ? "border-border/40 bg-muted/10"
          : "border-border/70 bg-background"
      }`}
    >
      {/* Section header */}
      <div
        role="button"
        tabIndex={0}
        onClick={() => !isEmpty && setExpanded(!expanded)}
        onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); !isEmpty && setExpanded(!expanded); } }}
        className={`w-full flex items-center justify-between px-4 py-2.5 text-left select-none transition-colors ${
          isEmpty
            ? "cursor-default"
            : "cursor-pointer hover:bg-muted/40"
        }`}
      >
        <div className="flex items-center gap-2 min-w-0">
          {isEmpty ? (
            <span className="h-4 w-4 shrink-0" />
          ) : expanded ? (
            <ChevronDown className="h-4 w-4 text-muted-foreground shrink-0" />
          ) : (
            <ChevronRight className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <span className={`font-medium text-sm truncate ${isEmpty ? "text-muted-foreground/60" : ""}`}>
            {section.label}
          </span>
          {section.total > 0 ? (
            <span className="shrink-0 inline-flex items-center justify-center h-5 min-w-[20px] px-1.5 rounded-full bg-primary/10 text-primary text-[10px] font-semibold tabular-nums">
              {section.total}
            </span>
          ) : (
            <span className="text-[10px] text-muted-foreground/40 shrink-0">0</span>
          )}
          {section.error && (
            <span className="text-[10px] text-red-500 font-medium shrink-0">error</span>
          )}
          {verdictSummary && (
            <span className="text-[10px] text-muted-foreground/70 shrink-0 ml-1">
              {verdictSummary.checked}/{verdictSummary.total} checked
              {verdictSummary.confirmed > 0 && <span className="text-emerald-600"> · {verdictSummary.confirmed} confirmed</span>}
              {verdictSummary.contradicted > 0 && <span className="text-red-500"> · {verdictSummary.contradicted} disputed</span>}
              {verdictSummary.outdated > 0 && <span className="text-amber-600"> · {verdictSummary.outdated} outdated</span>}
            </span>
          )}
        </div>
        {section.recordType && (
          <Link
            href={`/internal/entity-source-checks`}
            onClick={(e) => e.stopPropagation()}
            className="shrink-0 text-[10px] text-muted-foreground/50 hover:text-muted-foreground mr-1"
            title="Review source checks"
          >
            Source checks →
          </Link>
        )}
        <button
          onClick={(e) => {
            e.stopPropagation();
            setShowSchema(!showSchema);
          }}
          className={`shrink-0 p-1.5 rounded-md transition-colors ${
            showSchema
              ? "bg-primary/10 text-primary"
              : "text-muted-foreground/50 hover:text-muted-foreground hover:bg-muted/60"
          }`}
          title="Toggle schema info"
          aria-label="Toggle schema info"
        >
          <TableProperties className="h-3.5 w-3.5" />
        </button>
      </div>

      {/* Schema panel */}
      {showSchema && (
        <div className="px-4 py-3 border-t border-dashed border-border/50 bg-muted/20">
          <p className="text-[11px] text-muted-foreground mb-2.5 leading-relaxed">
            {section.description}
          </p>
          <div className="flex flex-wrap gap-1.5">
            {section.schema.columns.map((col) => (
              <div
                key={col.name}
                className="inline-flex items-center gap-1 text-[10px] bg-background border border-border/50 rounded-md px-2 py-1 shadow-sm"
                title={col.description ?? `${col.columnType}${col.notNull ? " NOT NULL" : ""}`}
              >
                <span className="font-mono text-foreground/80">{col.name}</span>
                <TypeBadge dataType={col.dataType} />
                {col.notNull && (
                  <span className="text-red-400 dark:text-red-500 font-bold leading-none" title="NOT NULL">*</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Data rows */}
      {expanded && !isEmpty && (
        <div className="border-t border-border/50 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="bg-muted/50 dark:bg-muted/30">
                <th className="px-2 py-2 w-16 border-b border-border/40 text-[10px] font-medium text-muted-foreground/40">
                  ID
                </th>
                {visibleColumns.map((col) => (
                  <th
                    key={col.name}
                    className="px-3 py-2 text-left font-semibold text-muted-foreground whitespace-nowrap border-b border-border/40"
                    title={col.description}
                  >
                    {formatColumnHeader(col.name)}
                  </th>
                ))}
                {section.recordType && (
                  <th className="px-2 py-2 w-8 border-b border-border/40" title="Verification status">
                    <ShieldCheck className="h-3 w-3 text-muted-foreground/50" />
                  </th>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-border/30">
              {displayedRows.map((row, i) => {
                const rawId = row.id;
                const recordId = rawId != null ? String(rawId) : undefined;
                const verdict = recordId ? verdicts[recordId] : undefined;
                return (
                  <tr key={i} className="hover:bg-muted/20 transition-colors">
                    {(() => {
                      const idStr = recordId ?? null;
                      if (!idStr) return <td className="px-2 py-2" />;
                      const display = idStr.length > 7 ? idStr.slice(0, 7) : idStr;
                      // Compute thing key for linking to /things/<id>
                      // Only link sections with recordType (those have things table entries)
                      // Facts use a composite key (entityId:factId); all others use row.id
                      let href: string | null = null;
                      if (section.recordType) {
                        let linkId = idStr;
                        if (section.recordType === "fact") {
                          const entityId = row.entityId ?? row.entity_id;
                          const factId = row.factId ?? row.fact_id;
                          if (entityId && factId) {
                            linkId = `${encodeURIComponent(String(entityId))}:${encodeURIComponent(String(factId))}`;
                          }
                        }
                        href = `/things/${linkId}`;
                      }
                      return href ? (
                        <td className="px-2 py-2 align-top">
                          <Link
                            href={href}
                            className="font-mono text-[9px] text-muted-foreground/40 hover:text-blue-600 dark:hover:text-blue-400 hover:underline"
                            title={`Record ${idStr}`}
                          >
                            {display}
                          </Link>
                        </td>
                      ) : (
                        <td className="px-2 py-2 align-top">
                          <span className="font-mono text-[9px] text-muted-foreground/30" title={idStr}>
                            {display}
                          </span>
                        </td>
                      );
                    })()}
                    {visibleColumns.map((col) => {
                      const camelKey = snakeToCamel(col.name);
                      const value = camelKey in row ? row[camelKey] : row[col.name];
                      return (
                        <td key={col.name} className="px-3 py-2 align-top">
                          <CellValue value={value} columnName={col.name} displayNames={displayNames} row={row} />
                        </td>
                      );
                    })}
                    {section.recordType && (
                      <td className="px-2 py-2 align-top">
                        <SourceCheckDot
                          status={verdict ? recordVerdictToStatus(verdict.verdict) : "not_run"}
                          originalVerdict={verdict?.verdict}
                          size="md"
                          href={verdict && recordId ? `/source-checks/${encodeURIComponent(section.recordType)}/${encodeURIComponent(recordId)}` : undefined}
                        />
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!showAllRows && section.rows.length > INITIAL_ROW_LIMIT && (
            <button
              onClick={() => setShowAllRows(true)}
              className="w-full py-2 text-xs text-muted-foreground hover:text-foreground hover:bg-muted/30 transition-colors border-t border-border/30"
            >
              Show all {section.rows.length} rows ({section.rows.length - INITIAL_ROW_LIMIT} more)
            </button>
          )}
        </div>
      )}

      {expanded && isEmpty && !section.error && (
        <div className="border-t border-border/30 px-4 py-3 text-center text-[11px] text-muted-foreground/50">
          No records
        </div>
      )}

      {expanded && section.error && (
        <div className="border-t border-red-200 dark:border-red-800/50 px-4 py-3 text-center text-[11px] text-red-600 dark:text-red-400 bg-red-50/50 dark:bg-red-950/20">
          Query error: {section.error}
        </div>
      )}
    </div>
  );
}

// ── Helpers ────────────────────────────────────────────────────────────────

function snakeToCamel(s: string): string {
  return s.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}

function formatColumnHeader(name: string): string {
  if (COLUMN_HEADER_OVERRIDES[name]) return COLUMN_HEADER_OVERRIDES[name];
  return name
    .replace(/_/g, " ")
    .replace(/\b[a-z]/g, (c) => c.toUpperCase())
    .replace(/\bId\b/g, "ID")
    .replace(/\bUrl\b/g, "URL")
    .replace(/\bFk\b/g, "FK");
}

// ── Stat pill ──────────────────────────────────────────────────────────────

function StatPill({
  icon: Icon,
  label,
  value,
}: {
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  value: string | number;
}) {
  return (
    <div className="inline-flex items-center gap-2 rounded-md border border-border/50 bg-muted/30 px-3 py-1.5">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">{label}</span>
      <span className="text-xs font-semibold tabular-nums">{value}</span>
    </div>
  );
}

// ── Entity summary ─────────────────────────────────────────────────────────

function EntitySummary({ entity }: { entity: Record<string, unknown> }) {
  const title = String(entity.title ?? "");
  const entityType = String(entity.entityType ?? "");
  const numericId = entity.numericId ? String(entity.numericId) : null;
  const description = entity.description ? String(entity.description) : null;
  const slug = String(entity.id ?? "");
  const stableId = String(entity.stableId ?? "");
  const website = entity.website ? String(entity.website) : null;
  const status = entity.status ? String(entity.status) : null;

  return (
    <div className="rounded-lg border border-border/60 p-5 mb-5">
      <div className="flex items-start justify-between gap-4 mb-2">
        <div className="flex items-center gap-2.5 flex-wrap min-w-0">
          <h2 className="text-lg font-semibold leading-tight">{title}</h2>
          <span className="inline-flex items-center gap-1 text-[11px] font-medium bg-primary/8 text-primary border border-primary/15 px-2 py-0.5 rounded-md">
            {entityType}
          </span>
          {numericId && (
            <span className="text-[11px] font-mono text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
              {numericId}
            </span>
          )}
          {status && (
            <span className={`text-[11px] font-medium px-2 py-0.5 rounded-md border ${
              status === "active"
                ? "bg-emerald-50 text-emerald-700 border-emerald-200 dark:bg-emerald-950/30 dark:text-emerald-400 dark:border-emerald-800"
                : "bg-muted text-muted-foreground border-border/50"
            }`}>
              {status}
            </span>
          )}
        </div>
        {website && (
          <a
            href={website}
            target="_blank"
            rel="noopener noreferrer"
            className="shrink-0 inline-flex items-center gap-1 text-[11px] text-blue-600 dark:text-blue-400 hover:underline"
          >
            <ExternalLink className="h-3 w-3" />
            website
          </a>
        )}
      </div>

      {description && (
        <p className="text-sm text-muted-foreground leading-relaxed mb-3">
          {description}
        </p>
      )}

      <div className="flex gap-x-5 gap-y-1 text-[11px] text-muted-foreground flex-wrap font-mono">
        <span>
          <span className="text-foreground/40 font-sans">slug</span>{" "}
          {slug}
        </span>
        <span>
          <span className="text-foreground/40 font-sans">stableId</span>{" "}
          {stableId}
        </span>
      </div>
    </div>
  );
}

// ── Empty state ────────────────────────────────────────────────────────────

const EXAMPLE_ENTITIES = [
  { slug: "anthropic", label: "Anthropic" },
  { slug: "openai", label: "OpenAI" },
  { slug: "google-deepmind", label: "DeepMind" },
  { slug: "dario-amodei", label: "Dario Amodei" },
  { slug: "open-philanthropy", label: "Open Philanthropy" },
];

function EmptyState({ onSearch }: { onSearch: (q: string) => void }) {
  return (
    <div className="rounded-lg border border-dashed border-border/60 px-8 py-12 text-center">
      <Database className="h-10 w-10 mx-auto mb-4 text-muted-foreground/25" />
      <p className="text-base font-medium text-muted-foreground mb-1.5">
        Entity Profile Explorer
      </p>
      <p className="text-sm text-muted-foreground/70 max-w-lg mx-auto mb-5">
        View all database records for any entity &mdash;
        personnel, grants, divisions, funding, benchmarks, and more.
      </p>
      <div className="flex items-center justify-center gap-2 flex-wrap">
        <span className="text-xs text-muted-foreground/50">Try:</span>
        {EXAMPLE_ENTITIES.map((e) => (
          <button
            key={e.slug}
            onClick={() => onSearch(e.slug)}
            className="text-xs font-mono px-2.5 py-1 rounded-md border border-border/50 bg-muted/30 text-foreground/70 hover:bg-muted hover:text-foreground transition-colors"
          >
            {e.label}
          </button>
        ))}
      </div>
    </div>
  );
}


// ── Entity JSONB data sections ────────────────────────────────────────────

/** Render structured entity data from JSONB columns (metadata, customFields, etc.) */
function EntityDataSections({ entity }: { entity: Record<string, unknown> }) {
  const metadata = (entity.metadata && typeof entity.metadata === "object" && !Array.isArray(entity.metadata))
    ? entity.metadata as Record<string, unknown>
    : null;
  const customFields = Array.isArray(entity.customFields) ? entity.customFields as Array<{ label: string; value: string; link?: string }> : null;
  const relatedEntries = Array.isArray(entity.relatedEntries) ? entity.relatedEntries as Array<{ id: string; type: string; relationship?: string }> : null;

  // Extract interesting metadata keys (skip boring ones)
  const metadataEntries = metadata
    ? Object.entries(metadata).filter(([, v]) => v !== null && v !== undefined && v !== "")
    : [];

  const hasData = metadataEntries.length > 0 || (customFields && customFields.length > 0) ||
    (relatedEntries && relatedEntries.length > 0);

  if (!hasData) return null;

  return (
    <div className="space-y-2 mb-4">
      {/* Metadata fields (type-specific: stakeholders, provisions, votes, etc.) */}
      {metadataEntries.length > 0 && (
        <CollapsibleJsonSection
          title="Entity Properties"
          description="Type-specific fields from the entity YAML definition"
          count={metadataEntries.length}
          data={metadata!}
        />
      )}

      {/* Custom fields */}
      {customFields && customFields.length > 0 && (
        <CollapsibleTableSection
          title="Custom Fields"
          description="Key-value fields from entity YAML"
          headers={["Label", "Value", "Link"]}
          rows={customFields.map((f) => [f.label, f.value, f.link ?? ""])}
        />
      )}

      {/* Related entries */}
      {relatedEntries && relatedEntries.length > 0 && (
        <CollapsibleTableSection
          title="Related Entries"
          description="Cross-references to other entities"
          headers={["Entity ID", "Type", "Relationship"]}
          rows={relatedEntries.map((r) => [r.id, r.type, r.relationship ?? ""])}
        />
      )}

    </div>
  );
}

/** Collapsible section that renders a JSON tree */
function CollapsibleJsonSection({
  title,
  description,
  count,
  data,
}: {
  title: string;
  description: string;
  count: number;
  data: Record<string, unknown>;
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="text-sm font-medium">{title}</span>
        <span className="text-[11px] font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
          {count}
        </span>
        <span className="text-[11px] text-muted-foreground/60 ml-auto">{description}</span>
      </button>
      {expanded && (
        <div className="border-t border-border/30 px-4 py-3 overflow-x-auto">
          {Object.entries(data).map(([key, value]) => (
            <div key={key} className="mb-3 last:mb-0">
              <div className="text-[11px] font-mono font-semibold text-muted-foreground mb-1">{key}</div>
              {Array.isArray(value) ? (
                <div className="ml-2 space-y-1">
                  {value.map((item, i) => (
                    <div key={i} className="text-xs border-l-2 border-border/50 pl-2">
                      {typeof item === "object" && item !== null ? (
                        <pre className="text-[11px] whitespace-pre-wrap break-words text-muted-foreground">
                          {JSON.stringify(item, null, 2)}
                        </pre>
                      ) : (
                        <span className="text-foreground/80">{String(item)}</span>
                      )}
                    </div>
                  ))}
                </div>
              ) : typeof value === "object" && value !== null ? (
                <pre className="text-[11px] ml-2 whitespace-pre-wrap break-words text-muted-foreground">
                  {JSON.stringify(value, null, 2)}
                </pre>
              ) : (
                <div className="text-xs ml-2 text-foreground/80">{String(value)}</div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/** Collapsible section with a simple table */
function CollapsibleTableSection({
  title,
  description,
  headers,
  rows,
}: {
  title: string;
  description: string;
  headers: string[];
  rows: string[][];
}) {
  const [expanded, setExpanded] = useState(false);

  return (
    <div className="rounded-lg border border-border/50 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2.5 text-left hover:bg-muted/30 transition-colors"
      >
        {expanded ? (
          <ChevronDown className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 text-muted-foreground shrink-0" />
        )}
        <span className="text-sm font-medium">{title}</span>
        <span className="text-[11px] font-mono text-muted-foreground bg-muted/50 px-1.5 py-0.5 rounded">
          {rows.length}
        </span>
        <span className="text-[11px] text-muted-foreground/60 ml-auto">{description}</span>
      </button>
      {expanded && (
        <div className="border-t border-border/30 overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="bg-muted/20">
                {headers.map((h) => (
                  <th key={h} className="px-3 py-1.5 text-left font-medium text-muted-foreground text-[11px]">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, i) => (
                <tr key={i} className="border-t border-border/20">
                  {row.map((cell, j) => (
                    <td key={j} className="px-3 py-1.5 text-foreground/80 max-w-xs truncate">
                      {(cell.startsWith("http://") || cell.startsWith("https://")) ? (
                        <a href={cell} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">
                          {cell.length > 60 ? cell.slice(0, 60) + "..." : cell}
                        </a>
                      ) : (
                        cell || <span className="text-muted-foreground/20">&mdash;</span>
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── Main viewer ────────────────────────────────────────────────────────────

export function EntityProfileViewer({
  initialData,
  initialEntity,
  backHref,
  backLabel,
  hideSearch,
}: {
  initialData: EntityProfileData | null;
  initialEntity: string;
  /** Optional back link (e.g., "/organizations/anthropic") shown above the viewer */
  backHref?: string;
  /** Label for the back link (e.g., "Anthropic") */
  backLabel?: string;
  /** Hide search bar — used when embedded in a page that already identifies the entity */
  hideSearch?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const urlEntity = searchParams.get("entity") ?? "";
  const effectiveInitial = initialEntity || urlEntity;
  const [data, setData] = useState<EntityProfileData | null>(initialData);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortControllerRef = useRef<AbortController | null>(null);
  // Track last manually-searched query to avoid duplicate requests from useEffect
  const lastManualSearchRef = useRef<string | null>(null);

  const doSearch = useCallback(async (query: string) => {
    // Cancel any inflight request to prevent stale responses overwriting newer ones
    abortControllerRef.current?.abort();
    const controller = new AbortController();
    abortControllerRef.current = controller;

    setIsLoading(true);
    setError(null);

    try {
      const res = await fetch(
        `/api/entity-profile-proxy?entity=${encodeURIComponent(query)}`,
        { signal: controller.signal }
      );
      if (controller.signal.aborted) return;
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body.message || `HTTP ${res.status}`);
        setData(null);
      } else {
        setData(await res.json());
      }
    } catch (err) {
      if (err instanceof DOMException && err.name === "AbortError") return;
      setError(err instanceof Error ? err.message : String(err));
      setData(null);
    } finally {
      if (!controller.signal.aborted) {
        setIsLoading(false);
      }
    }
  }, []);

  // Auto-load: when initialEntity is set (e.g., from /organizations/anthropic/db)
  // or when the URL entity param changes (handles browser back/forward)
  useEffect(() => {
    const urlEntityParam = searchParams.get("entity");
    const target = urlEntityParam || initialEntity;
    if (target && !initialData) {
      // Skip if this was already triggered by handleSearch to avoid double-fetching
      if (lastManualSearchRef.current === target) {
        lastManualSearchRef.current = null;
        return;
      }
      doSearch(target);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams, initialData, doSearch]);

  const handleSearch = useCallback(
    (query: string) => {
      lastManualSearchRef.current = query;
      const params = new URLSearchParams(searchParams.toString());
      params.set("entity", query);
      router.push(`?${params.toString()}`, { scroll: false });
      doSearch(query);
    },
    [router, searchParams, doSearch]
  );

  const stats = useMemo(() => {
    if (!data) return null;
    const totalRecords = data.sections.reduce((sum, s) => sum + s.total, 0);
    const populated = data.sections.filter((s) => s.total > 0).length;
    const verifiedCount = Object.keys(data.verdicts).length;
    // Only count records from sections that support verification (have recordType)
    const verifiableRecords = data.sections
      .filter((s) => s.recordType)
      .reduce((sum, s) => sum + s.total, 0);
    return { totalRecords, populated, total: data.sections.length, verifiedCount, verifiableRecords };
  }, [data]);

  // Sort populated sections first — memoized to avoid re-sorting on every render
  const [showAllSections, setShowAllSections] = useState(false);

  // Filter sections by entity type relevance, then sort populated first
  const { visibleSections, hiddenCount } = useMemo(() => {
    if (!data) return { visibleSections: [], hiddenCount: 0 };
    const entityType = String(data.entity.entityType ?? "");
    const excludeSet = SECTIONS_EXCLUDE[entityType];

    const all = data.sections.slice();
    let filtered: Section[];
    let hidden = 0;

    if (showAllSections || !excludeSet) {
      filtered = all;
    } else {
      filtered = all.filter((s) => {
        if (excludeSet.has(s.key) && s.total === 0) {
          hidden++;
          return false;
        }
        return true;
      });
    }

    // Sort: populated first, then alphabetically
    filtered.sort((a, b) => (b.total > 0 ? 1 : 0) - (a.total > 0 ? 1 : 0));
    return { visibleSections: filtered, hiddenCount: hidden };
  }, [data, showAllSections]);

  return (
    <div>
      {backHref && (
        <div className="mb-4">
          <Link
            href={backHref}
            className="text-sm text-muted-foreground hover:text-foreground transition-colors"
          >
            &larr; {backLabel || "Back"}
          </Link>
        </div>
      )}
      {!hideSearch && (
        <EntitySearch
          initialQuery={effectiveInitial}
          onSearch={handleSearch}
          isLoading={isLoading}
        />
      )}

      {error && (
        <div className={hideSearch
          ? "rounded-lg border border-border/60 bg-muted/30 p-6 mb-5 text-center"
          : "rounded-lg border border-red-200 dark:border-red-800/50 bg-red-50 dark:bg-red-950/20 p-4 mb-5 text-sm text-red-700 dark:text-red-400"
        }>
          {hideSearch ? (
            <>
              <Database className="h-8 w-8 mx-auto mb-3 text-muted-foreground/30" />
              <p className="text-sm font-medium text-muted-foreground">Database records unavailable</p>
              <p className="mt-1.5 text-xs text-muted-foreground/60 max-w-md mx-auto">
                The database server could not be reached. Records will appear here when the server is available.
              </p>
              <button
                onClick={() => doSearch(effectiveInitial)}
                className="mt-4 px-4 py-1.5 text-xs font-medium rounded-md border border-border/60 text-muted-foreground hover:bg-muted/50 hover:text-foreground transition-colors cursor-pointer"
              >
                Retry
              </button>
            </>
          ) : (
            <>
              {error}
              {/not found/i.test(error) && (
                <p className="mt-1.5 text-xs text-red-600/70 dark:text-red-400/60">
                  Try using the exact slug (e.g. &quot;anthropic&quot;), a stableId (e.g. &quot;sid_...&quot;), or a wikiId (e.g. &quot;E22&quot;).
                </p>
              )}
            </>
          )}
        </div>
      )}

      {data && stats && (
        <>
          {!hideSearch && <EntitySummary entity={data.entity} />}

          <div className="flex gap-2 mb-5 flex-wrap">
            <StatPill icon={Database} label="Records" value={stats.totalRecords} />
            <StatPill
              icon={Layers}
              label="Tables"
              value={`${stats.populated}/${stats.total}`}
            />
            {stats.verifiedCount > 0 && (
              <StatPill icon={ShieldCheck} label="Verified" value={`${stats.verifiedCount}/${stats.verifiableRecords}`} />
            )}
          </div>

          {/* Entity JSONB fields (metadata, customFields, relatedEntries) */}
          <EntityDataSections entity={data.entity} />

          <div className="space-y-2">
            {SECTION_GROUPS.map((group) => {
              const groupSections = visibleSections.filter((s) => group.keys.includes(s.key));
              if (groupSections.length === 0) return null;
              const groupTotal = groupSections.reduce((sum, s) => sum + s.total, 0);
              return (
                <div key={group.label}>
                  <div className="flex items-center gap-2 mt-4 mb-1.5 px-1">
                    <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground/50">
                      {group.label}
                    </span>
                    <span className="text-[10px] text-muted-foreground/30 tabular-nums">{groupTotal}</span>
                    <div className="flex-1 border-t border-border/20" />
                  </div>
                  <div className="space-y-2">
                    {groupSections.map((section) => (
                      <ProfileSection
                        key={section.key}
                        section={section}
                        verdicts={data.verdicts}
                        defaultExpanded={section.total > 0 && section.total <= 50}
                        displayNames={data.displayNames ?? {}}
                      />
                    ))}
                  </div>
                </div>
              );
            })}
            {/* Sections not in any group */}
            {visibleSections
              .filter((s) => !SECTION_GROUPS.some((g) => g.keys.includes(s.key)))
              .map((section) => (
                <ProfileSection
                  key={section.key}
                  section={section}
                  verdicts={data.verdicts}
                  displayNames={data.displayNames ?? {}}
                  defaultExpanded={section.total > 0 && section.total <= 50}
                />
              ))}
            {hiddenCount > 0 && !showAllSections && (
              <button
                onClick={() => setShowAllSections(true)}
                className="w-full py-2 text-xs text-muted-foreground/50 hover:text-muted-foreground transition-colors"
              >
                Show {hiddenCount} hidden sections (irrelevant for this entity type)
              </button>
            )}
          </div>
        </>
      )}

      {!data && !error && !isLoading && !hideSearch && <EmptyState onSearch={handleSearch} />}
      {!data && !error && isLoading && hideSearch && (
        <div className="flex items-center justify-center py-12 gap-2 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading database records...
        </div>
      )}
    </div>
  );
}
