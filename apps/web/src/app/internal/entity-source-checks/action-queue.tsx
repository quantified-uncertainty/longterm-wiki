"use client";

import { useState, useEffect } from "react";
import { Loader2, AlertTriangle, Clock, RefreshCw } from "lucide-react";
import { cn } from "@/lib/utils";
import {
  SOURCE_CHECK_VERDICT_STYLES,
  type VerdictRow,
} from "@/components/shared/verdict-styles";

// ── Types ──────────────────────────────────────────────────────────────────

type NameMap = Record<string, string>;

// ── Verdict styling ────────────────────────────────────────────────────────
// Extends the shared source-check styles with lucide icons for the action queue.

const VERDICT_STYLES_WITH_ICONS: Record<string, { bg: string; text: string; icon: typeof AlertTriangle }> = {
  contradicted: { ...SOURCE_CHECK_VERDICT_STYLES.contradicted, icon: AlertTriangle },
  outdated: { ...SOURCE_CHECK_VERDICT_STYLES.outdated, icon: Clock },
  partial: { ...SOURCE_CHECK_VERDICT_STYLES.partial, icon: RefreshCw },
};

// ── Helpers ────────────────────────────────────────────────────────────────

function formatTimeSince(dateStr: string | null): string {
  if (!dateStr) return "never";
  const d = new Date(dateStr);
  const now = new Date();
  const days = Math.floor((now.getTime() - d.getTime()) / (1000 * 60 * 60 * 24));
  if (days === 0) return "today";
  if (days === 1) return "1 day ago";
  if (days < 30) return `${days} days ago`;
  if (days < 365) return `${Math.floor(days / 30)} months ago`;
  return `${Math.floor(days / 365)} years ago`;
}

/**
 * Batch-resolve record IDs and entity IDs to human-readable names.
 * Groups IDs by record type and makes one request per type.
 */
async function resolveNames(verdicts: VerdictRow[]): Promise<NameMap> {
  const byType = new Map<string, Set<string>>();
  for (const v of verdicts) {
    const existing = byType.get(v.recordType);
    if (existing) {
      existing.add(v.recordId);
    } else {
      byType.set(v.recordType, new Set([v.recordId]));
    }
    if (v.entityId) {
      const entitySet = byType.get("entity");
      if (entitySet) {
        entitySet.add(v.entityId);
      } else {
        byType.set("entity", new Set([v.entityId]));
      }
    }
  }

  const result: NameMap = {};
  const fetches = [...byType.entries()].map(async ([recordType, ids]) => {
    const idList = [...ids].join(",");
    try {
      const res = await fetch(
        `/api/source-check-names-proxy?record_type=${encodeURIComponent(recordType)}&record_ids=${encodeURIComponent(idList)}`
      );
      if (!res.ok) return;
      const data = await res.json();
      const names = data.names as Record<string, string> | undefined;
      if (names) {
        for (const [id, name] of Object.entries(names)) {
          result[id] = name;
        }
      }
    } catch (e) {
      console.warn(`[action-queue] Failed to resolve names for ${recordType}: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  await Promise.all(fetches);
  return result;
}

// ── Main component ─────────────────────────────────────────────────────────

/**
 * Shows the most urgent items needing attention: contradicted, outdated,
 * and needs-recheck verdicts, in priority order.
 */
export function ActionQueue() {
  const [items, setItems] = useState<VerdictRow[]>([]);
  const [names, setNames] = useState<NameMap>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        // Fetch contradicted, outdated, and needs-recheck items in parallel
        const [contradictedRes, outdatedRes, recheckRes] = await Promise.all([
          fetch("/api/source-check-verdicts-proxy?verdict=contradicted&limit=20"),
          fetch("/api/source-check-verdicts-proxy?verdict=outdated&limit=10"),
          fetch("/api/source-check-verdicts-proxy?verdict=partial&limit=10"),
        ]);

        const results: VerdictRow[] = [];
        const seen = new Set<string>();
        let failedCount = 0;

        for (const res of [contradictedRes, outdatedRes, recheckRes]) {
          if (!res.ok) {
            failedCount++;
            console.warn(`[action-queue] API returned ${res.status}`);
            continue;
          }
          const data = await res.json();
          const verdicts = (data.verdicts ?? []) as VerdictRow[];
          for (const v of verdicts) {
            const key = `${v.recordType}:${v.recordId}:${v.fieldName ?? ""}`;
            if (!seen.has(key)) {
              seen.add(key);
              results.push(v);
            }
          }
        }

        // If ALL fetches failed, show an error instead of false "all clear"
        if (failedCount === 3) {
          setError("Could not reach wiki-server. Action items may exist but cannot be loaded.");
        }

        setItems(results);

        // Resolve names in background
        if (results.length > 0) {
          resolveNames(results).then(
            (resolved) => setNames(resolved),
            (e) => console.warn(`[action-queue] Name resolution failed: ${e instanceof Error ? e.message : String(e)}`)
          );
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setIsLoading(false);
      }
    })();
  }, []);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8 text-muted-foreground">
        <Loader2 className="h-5 w-5 animate-spin mr-2" /> Loading action queue...
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-600">
        Failed to load action queue: {error}
      </div>
    );
  }

  if (items.length === 0) {
    return (
      <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
        <p className="text-sm font-medium text-emerald-700 dark:text-emerald-400">
          No urgent items found
        </p>
        <p className="text-xs text-muted-foreground mt-1">
          All verified records look good. Check back after more source checks run.
        </p>
      </div>
    );
  }

  // Group by verdict in priority order
  const contradicted = items.filter((i) => i.verdict === "contradicted");
  const outdated = items.filter((i) => i.verdict === "outdated");
  const partial = items.filter((i) => i.verdict === "partial");

  return (
    <div className="not-prose space-y-6">
      <div className="flex items-baseline justify-between">
        <h3 className="text-base font-semibold">Action Queue</h3>
        <span className="text-xs text-muted-foreground">
          {items.length} items need attention
        </span>
      </div>

      {contradicted.length > 0 && (
        <ActionGroup
          title="Contradicted"
          description="Data contradicts source material"
          items={contradicted}
          names={names}
          variant="contradicted"
        />
      )}

      {outdated.length > 0 && (
        <ActionGroup
          title="Outdated"
          description="Source data has changed since last check"
          items={outdated}
          names={names}
          variant="outdated"
        />
      )}

      {partial.length > 0 && (
        <ActionGroup
          title="Partial Match"
          description="Data partially matches source material"
          items={partial}
          names={names}
          variant="partial"
        />
      )}
    </div>
  );
}

// ── Action group ───────────────────────────────────────────────────────────

function ActionGroup({
  title,
  description,
  items,
  names,
  variant,
}: {
  title: string;
  description: string;
  items: VerdictRow[];
  names: NameMap;
  variant: "contradicted" | "outdated" | "partial";
}) {
  const style = VERDICT_STYLES_WITH_ICONS[variant];
  const Icon = style.icon;

  return (
    <div className="rounded-lg border border-border/60 overflow-hidden">
      <div className={cn("flex items-center gap-2 px-4 py-2.5 border-b border-border/40", style.bg)}>
        <Icon className={cn("h-4 w-4", style.text)} />
        <span className={cn("text-sm font-semibold", style.text)}>{title}</span>
        <span className="text-xs text-muted-foreground ml-1">
          ({items.length}) &mdash; {description}
        </span>
      </div>
      <div className="divide-y divide-border/30">
        {items.map((item) => (
          <ActionItem
            key={`${item.recordType}:${item.recordId}:${item.fieldName ?? ""}`}
            item={item}
            names={names}
          />
        ))}
      </div>
    </div>
  );
}

// ── Single action item ─────────────────────────────────────────────────────

function ActionItem({ item, names }: { item: VerdictRow; names: NameMap }) {
  // Resolve the record-level name (e.g., fact label "Headquarters", personnel name)
  const recordName = names[item.recordId] ?? null;
  // Resolve the parent entity name (e.g., "Anthropic", "Elon Musk")
  const entityName = item.entityId ? (names[item.entityId] ?? null) : null;

  // Build display name: prefer "Entity: Record" when both are available
  // so users can distinguish multiple entries for the same entity.
  let displayName: string;
  if (recordName && entityName && recordName !== entityName) {
    displayName = `${entityName}: ${recordName}`;
  } else {
    displayName = recordName ?? entityName ?? item.recordId;
  }

  // Strip "new:" prefix from resolved display names
  if (displayName.startsWith("new:")) {
    displayName = displayName.slice(4);
  }

  const truncatedName = displayName.length > 60
    ? displayName.slice(0, 58) + "..."
    : displayName;

  const href = `/source-checks/${encodeURIComponent(item.recordType)}/${encodeURIComponent(item.recordId)}`;

  return (
    <a href={href} className="flex items-center justify-between gap-3 px-4 py-2.5 hover:bg-muted/30 transition-colors group">
      <div className="flex items-center gap-3 min-w-0">
        <span className="shrink-0 inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground">
          {item.recordType}
        </span>
        <span className="text-sm font-medium truncate group-hover:text-blue-600 dark:group-hover:text-blue-400" title={displayName}>
          {truncatedName}
        </span>
        {item.fieldName && (
          <span className="text-xs text-muted-foreground shrink-0">
            .{item.fieldName}
          </span>
        )}
      </div>
      <div className="flex items-center gap-3 shrink-0">
        {item.confidence != null && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {Math.round(item.confidence * 100)}%
          </span>
        )}
        <span className="text-xs text-muted-foreground whitespace-nowrap">
          {formatTimeSince(item.lastComputedAt)}
        </span>
      </div>
    </a>
  );
}
