"use client";

import { useState, useCallback, useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Search,
  Loader2,
  ShieldCheck,
  ShieldAlert,
  ShieldQuestion,
  Clock,
  ChevronRight,
  ExternalLink,
} from "lucide-react";
import { cn } from "@/lib/utils";

// ── Types ──────────────────────────────────────────────────────────────────

interface VerdictRow {
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  verdict: string;
  confidence: number | null;
  reasoning: string | null;
  sourcesChecked: number;
  needsRecheck: boolean;
  nextCheckDue: string | null;
  lastComputedAt: string | null;
  createdAt: string | null;
  updatedAt: string | null;
}

interface EvidenceRow {
  id: number;
  recordType: string;
  recordId: string;
  fieldName: string | null;
  entityId: string | null;
  expectedValue: string | null;
  resourceId: string | null;
  sourceUrl: string | null;
  extractedValue: string | null;
  extractedQuote: string | null;
  verdict: string;
  confidence: number | null;
  isPrimarySource: boolean;
  checkerModel: string | null;
  notes: string | null;
  checkedAt: string | null;
}

interface VerdictsResponse {
  verdicts: VerdictRow[];
  total: number;
}

// ── Verdict styling ─────────────────────────────────────────────────────

const VERDICT_STYLES: Record<string, { bg: string; text: string; icon: typeof ShieldCheck }> = {
  confirmed: { bg: "bg-emerald-500/15", text: "text-emerald-600", icon: ShieldCheck },
  contradicted: { bg: "bg-red-500/15", text: "text-red-600", icon: ShieldAlert },
  outdated: { bg: "bg-amber-500/15", text: "text-amber-600", icon: Clock },
  partial: { bg: "bg-amber-400/15", text: "text-amber-500", icon: ShieldQuestion },
  unverifiable: { bg: "bg-gray-500/15", text: "text-gray-500", icon: ShieldQuestion },
  unchecked: { bg: "bg-gray-400/15", text: "text-gray-400", icon: ShieldQuestion },
};

function VerdictBadge({ verdict, confidence }: { verdict: string; confidence: number | null }) {
  const style = VERDICT_STYLES[verdict] || VERDICT_STYLES.unchecked;
  const Icon = style.icon;
  return (
    <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${style.bg} ${style.text}`}>
      <Icon className="h-3.5 w-3.5" />
      {verdict}
      {confidence != null && (
        <span className="text-[10px] opacity-70">
          {Math.round(confidence * 100)}%
        </span>
      )}
    </span>
  );
}

// ── Claim display ───────────────────────────────────────────────────────

function formatClaim(v: VerdictRow): string {
  const type = v.recordType.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
  if (v.fieldName) {
    return `${type} [${v.recordId}] . ${v.fieldName}`;
  }
  return `${type} [${v.recordId}]`;
}

// ── Entity search bar ───────────────────────────────────────────────────

function EntitySearchBar({
  initialQuery,
  onSearch,
  isLoading,
}: {
  initialQuery: string;
  onSearch: (q: string) => void;
  isLoading: boolean;
}) {
  const [query, setQuery] = useState(initialQuery);

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
          placeholder="Entity slug, stableId, or wikiId (e.g. anthropic, E42)"
          className="w-full h-10 pl-10 pr-4 border rounded-lg bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring transition-shadow"
        />
      </div>
      <button
        type="submit"
        disabled={isLoading || !query.trim()}
        className="h-10 px-4 rounded-lg bg-foreground text-background text-sm font-medium hover:bg-foreground/90 disabled:opacity-50 transition-colors"
      >
        Load
      </button>
    </form>
  );
}

// ── Stats summary ───────────────────────────────────────────────────────

function StatsSummary({ verdicts }: { verdicts: VerdictRow[] }) {
  const counts = new Map<string, number>();
  for (const v of verdicts) {
    counts.set(v.verdict, (counts.get(v.verdict) ?? 0) + 1);
  }
  const entries = [...counts.entries()].sort(([, a], [, b]) => b - a);

  const avgConfidence = verdicts.length > 0
    ? verdicts.reduce((sum, v) => sum + (v.confidence ?? 0), 0) / verdicts.length
    : 0;

  const needsRecheck = verdicts.filter((v) => v.needsRecheck).length;
  const recordTypes = new Set(verdicts.map((v) => v.recordType));

  return (
    <div className="not-prose mb-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Total Verdicts</p>
          <p className="text-2xl font-bold tabular-nums">{verdicts.length}</p>
          <p className="text-xs text-muted-foreground mt-1">
            {recordTypes.size} record type{recordTypes.size !== 1 ? "s" : ""}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Avg Confidence</p>
          <p className="text-2xl font-bold tabular-nums">
            {avgConfidence > 0 ? `${Math.round(avgConfidence * 100)}%` : "N/A"}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Needs Recheck</p>
          <p className={cn("text-2xl font-bold tabular-nums", needsRecheck > 0 ? "text-amber-600" : "")}>
            {needsRecheck}
          </p>
        </div>
        <div className="rounded-lg border border-border/60 p-4">
          <p className="text-xs text-muted-foreground mb-1">Verdict Distribution</p>
          <div className="flex gap-1 flex-wrap mt-1">
            {entries.map(([verdict, count]) => {
              const style = VERDICT_STYLES[verdict] || VERDICT_STYLES.unchecked;
              return (
                <span key={verdict} className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${style.bg} ${style.text}`}>
                  {verdict} {count}
                </span>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Verdict card with expandable evidence ───────────────────────────────

function VerdictCard({ verdict }: { verdict: VerdictRow }) {
  const [expanded, setExpanded] = useState(false);
  const [evidence, setEvidence] = useState<EvidenceRow[] | null>(null);
  const [loadingEvidence, setLoadingEvidence] = useState(false);

  const loadEvidence = useCallback(async () => {
    if (evidence) return;
    setLoadingEvidence(true);
    try {
      const res = await fetch(
        `/api/verification-detail?recordType=${encodeURIComponent(verdict.recordType)}&recordId=${encodeURIComponent(verdict.recordId)}`
      );
      if (res.ok) {
        const data = await res.json();
        setEvidence(data.evidence ?? []);
      } else {
        console.warn(`[entity-verifications] Failed to load evidence for ${verdict.recordType}/${verdict.recordId}: HTTP ${res.status}`);
        setEvidence([]);
      }
    } catch (e) {
      console.warn(`[entity-verifications] Failed to load evidence: ${e instanceof Error ? e.message : String(e)}`);
      setEvidence([]);
    } finally {
      setLoadingEvidence(false);
    }
  }, [verdict.recordType, verdict.recordId, evidence]);

  const handleToggle = () => {
    if (!expanded) loadEvidence();
    setExpanded(!expanded);
  };

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      {/* Header row */}
      <button
        type="button"
        onClick={handleToggle}
        className="w-full flex items-center gap-3 p-4 text-left hover:bg-muted/30 transition-colors"
      >
        <ChevronRight className={cn("h-4 w-4 text-muted-foreground transition-transform shrink-0", expanded && "rotate-90")} />
        <div className="flex-1 min-w-0">
          <p className="text-sm font-medium truncate">{formatClaim(verdict)}</p>
          {verdict.reasoning && (
            <p className="text-xs text-muted-foreground mt-0.5 line-clamp-1">{verdict.reasoning}</p>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <VerdictBadge verdict={verdict.verdict} confidence={verdict.confidence} />
          <span className="text-xs text-muted-foreground tabular-nums">
            {verdict.sourcesChecked} source{verdict.sourcesChecked !== 1 ? "s" : ""}
          </span>
        </div>
      </button>

      {/* Expanded evidence */}
      {expanded && (
        <div className="border-t border-border/40 bg-muted/20 p-4">
          {loadingEvidence && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin" /> Loading evidence...
            </div>
          )}
          {evidence && evidence.length === 0 && (
            <p className="text-sm text-muted-foreground">No evidence records found.</p>
          )}
          {evidence && evidence.length > 0 && (
            <div className="space-y-3">
              <p className="text-xs font-semibold text-muted-foreground">
                Evidence ({evidence.length} source{evidence.length !== 1 ? "s" : ""})
              </p>
              {evidence.map((e) => (
                <div key={e.id} className="rounded-md border border-border/40 bg-background p-3 text-sm">
                  <div className="flex items-start gap-2 mb-2">
                    <VerdictBadge verdict={e.verdict} confidence={e.confidence} />
                    {e.isPrimarySource && (
                      <span className="text-[10px] font-medium text-emerald-600 bg-emerald-500/10 rounded-full px-2 py-0.5">
                        primary
                      </span>
                    )}
                    {e.checkerModel && (
                      <span className="text-[10px] text-muted-foreground bg-muted rounded-full px-2 py-0.5">
                        {e.checkerModel}
                      </span>
                    )}
                    {e.checkedAt && (
                      <span className="text-[10px] text-muted-foreground ml-auto tabular-nums">
                        {new Date(e.checkedAt).toLocaleDateString()}
                      </span>
                    )}
                  </div>
                  {e.sourceUrl && (
                    <a
                      href={e.sourceUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs text-blue-600 hover:underline flex items-center gap-1 mb-1"
                    >
                      <ExternalLink className="h-3 w-3" />
                      {e.sourceUrl.length > 80 ? e.sourceUrl.slice(0, 77) + "..." : e.sourceUrl}
                    </a>
                  )}
                  {e.expectedValue && (
                    <div className="text-xs mt-1">
                      <span className="text-muted-foreground">Expected: </span>
                      <span className="font-medium">{e.expectedValue}</span>
                    </div>
                  )}
                  {e.extractedValue && (
                    <div className="text-xs mt-0.5">
                      <span className="text-muted-foreground">Found: </span>
                      <span className="font-medium">{e.extractedValue}</span>
                    </div>
                  )}
                  {e.extractedQuote && (
                    <blockquote className="text-xs text-muted-foreground mt-1 pl-3 border-l-2 border-border italic line-clamp-3">
                      {e.extractedQuote}
                    </blockquote>
                  )}
                  {e.notes && (
                    <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{e.notes}</p>
                  )}
                </div>
              ))}
            </div>
          )}
          {verdict.reasoning && (
            <div className="mt-3 pt-3 border-t border-border/40">
              <p className="text-xs font-semibold text-muted-foreground mb-1">Aggregate Reasoning</p>
              <p className="text-xs text-muted-foreground">{verdict.reasoning}</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ── Filter tabs ─────────────────────────────────────────────────────────

function FilterTabs({
  verdicts,
  activeType,
  onChangeType,
  activeVerdict,
  onChangeVerdict,
}: {
  verdicts: VerdictRow[];
  activeType: string;
  onChangeType: (t: string) => void;
  activeVerdict: string;
  onChangeVerdict: (v: string) => void;
}) {
  const typeCounts = new Map<string, number>();
  const verdictCounts = new Map<string, number>();
  for (const v of verdicts) {
    typeCounts.set(v.recordType, (typeCounts.get(v.recordType) ?? 0) + 1);
    verdictCounts.set(v.verdict, (verdictCounts.get(v.verdict) ?? 0) + 1);
  }

  return (
    <div className="not-prose space-y-3 mb-4">
      {/* Record type filter */}
      <div className="flex gap-1.5 flex-wrap">
        <button
          onClick={() => onChangeType("all")}
          className={cn(
            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            activeType === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80"
          )}
        >
          All types ({verdicts.length})
        </button>
        {[...typeCounts.entries()].sort(([, a], [, b]) => b - a).map(([type, count]) => (
          <button
            key={type}
            onClick={() => onChangeType(type)}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
              activeType === type ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80"
            )}
          >
            {type} ({count})
          </button>
        ))}
      </div>
      {/* Verdict filter */}
      <div className="flex gap-1.5 flex-wrap">
        <button
          onClick={() => onChangeVerdict("all")}
          className={cn(
            "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
            activeVerdict === "all" ? "bg-foreground text-background" : "bg-muted text-muted-foreground hover:bg-muted/80"
          )}
        >
          All verdicts
        </button>
        {[...verdictCounts.entries()].sort(([, a], [, b]) => b - a).map(([v, count]) => {
          const style = VERDICT_STYLES[v] || VERDICT_STYLES.unchecked;
          return (
            <button
              key={v}
              onClick={() => onChangeVerdict(v)}
              className={cn(
                "px-3 py-1.5 rounded-md text-xs font-medium transition-colors",
                activeVerdict === v ? `${style.bg} ${style.text}` : "bg-muted text-muted-foreground hover:bg-muted/80"
              )}
            >
              {v} ({count})
            </button>
          );
        })}
      </div>
    </div>
  );
}

// ── Main viewer ─────────────────────────────────────────────────────────

export function EntityVerificationsViewer() {
  const searchParams = useSearchParams();
  const router = useRouter();

  const entityParam = searchParams.get("entity") ?? "";
  const [verdicts, setVerdicts] = useState<VerdictRow[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [activeType, setActiveType] = useState("all");
  const [activeVerdict, setActiveVerdict] = useState("all");

  const fetchVerdicts = useCallback(async (entityId: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const res = await fetch(
        `/api/entity-verifications-proxy?entity_id=${encodeURIComponent(entityId)}`
      );
      if (!res.ok) {
        const data = await res.json().catch(() => null);
        throw new Error(data?.message ?? `HTTP ${res.status}`);
      }
      const data: VerdictsResponse = await res.json();
      setVerdicts(data.verdicts);
      setLoaded(true);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setIsLoading(false);
    }
  }, []);

  // Auto-load from URL param on initial mount only
  useEffect(() => {
    if (entityParam && !loaded && !isLoading) {
      fetchVerdicts(entityParam);
    }
    // Only run on mount — entityParam changes are handled by handleSearch
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleSearch = (q: string) => {
    router.push(`?entity=${encodeURIComponent(q)}`, { scroll: false });
    setActiveType("all");
    setActiveVerdict("all");
    fetchVerdicts(q);
  };

  const filtered = verdicts.filter((v) => {
    if (activeType !== "all" && v.recordType !== activeType) return false;
    if (activeVerdict !== "all" && v.verdict !== activeVerdict) return false;
    return true;
  });

  return (
    <div className="not-prose">
      <EntitySearchBar
        initialQuery={entityParam}
        onSearch={handleSearch}
        isLoading={isLoading}
      />

      {error && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 mb-6 text-sm text-red-600">
          {error}
        </div>
      )}

      {!loaded && !isLoading && !error && (
        <div className="text-center py-12 text-muted-foreground">
          <ShieldCheck className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">Enter an entity identifier above to view its verification status.</p>
          <p className="text-xs mt-1">Supports entity slugs (anthropic), stableIds, or wikiIds (E42)</p>
        </div>
      )}

      {loaded && verdicts.length === 0 && (
        <div className="text-center py-12 text-muted-foreground">
          <ShieldQuestion className="h-12 w-12 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No verification verdicts found for this entity.</p>
        </div>
      )}

      {loaded && verdicts.length > 0 && (
        <>
          <StatsSummary verdicts={verdicts} />
          <FilterTabs
            verdicts={verdicts}
            activeType={activeType}
            onChangeType={setActiveType}
            activeVerdict={activeVerdict}
            onChangeVerdict={setActiveVerdict}
          />
          <div className="space-y-2">
            {filtered.map((v) => (
              <VerdictCard
                key={`${v.recordType}:${v.recordId}:${v.fieldName ?? ""}`}
                verdict={v}
              />
            ))}
          </div>
          {filtered.length === 0 && (
            <p className="text-center text-sm text-muted-foreground py-8">
              No verdicts match the current filters.
            </p>
          )}
        </>
      )}
    </div>
  );
}
