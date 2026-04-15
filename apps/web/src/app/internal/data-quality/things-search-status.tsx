/**
 * QUA-506 D5: staleness panel for the things_search materialized view.
 *
 * Surfaces last_refreshed_at, age, row count, and total size on
 * /internal/data-quality so operators can see at a glance when the
 * hourly groundskeeper refresh job silently stops firing. An MV with no
 * refresh is worse than no MV — it grows stale forever — so this panel
 * is load-bearing for Condition 2 of the QUA-476 benchmark recommendation.
 *
 * Coloring:
 *   - green: age < 70 min (healthy — refresh cadence is hourly with ~10 min slack)
 *   - amber: 70 min <= age < 2 h (one refresh has been skipped but not urgent)
 *   - red:   age >= 2 h (refresh job appears to have stopped firing)
 *   - gray:  MV missing entirely (migration 0181 hasn't run yet, or was rolled back)
 */

import { Card, CardContent } from "@/components/ui/card";
import {
  getThingsSearchRpcClient,
  type RpcThingsSearchStatusResult,
} from "@lib/wiki-server";

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatAge(seconds: number | null): string {
  if (seconds == null) return "unknown";
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.round(seconds / 60)}m`;
  if (seconds < 86400) {
    const h = Math.floor(seconds / 3600);
    const m = Math.round((seconds % 3600) / 60);
    return `${h}h ${m}m`;
  }
  return `${Math.round(seconds / 86400)}d`;
}

function ageColor(seconds: number | null): {
  bg: string;
  text: string;
  label: string;
} {
  if (seconds == null) {
    return {
      bg: "bg-gray-100 dark:bg-gray-800",
      text: "text-gray-700 dark:text-gray-300",
      label: "unknown",
    };
  }
  // Thresholds: hourly refresh cadence + 10 min slack → healthy up to 70 min
  if (seconds < 70 * 60) {
    return {
      bg: "bg-green-50 dark:bg-green-950/30",
      text: "text-green-700 dark:text-green-400",
      label: "healthy",
    };
  }
  if (seconds < 2 * 3600) {
    return {
      bg: "bg-yellow-50 dark:bg-yellow-950/30",
      text: "text-yellow-700 dark:text-yellow-500",
      label: "warning",
    };
  }
  return {
    bg: "bg-red-50 dark:bg-red-950/30",
    text: "text-red-700 dark:text-red-500",
    label: "stale",
  };
}

export async function ThingsSearchStatusSection() {
  const client = getThingsSearchRpcClient();
  if (!client) {
    return null;
  }

  let data: RpcThingsSearchStatusResult | null = null;
  let fetchError: string | null = null;

  try {
    const res = await client.status.$get();
    if (!res.ok) {
      fetchError = `HTTP ${res.status}`;
    } else {
      data = await res.json();
    }
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err);
  }

  return (
    <section>
      <h2 className="text-lg font-semibold mb-4">
        things_search Materialized View
        <span className="text-sm font-normal text-muted-foreground ml-2">
          (QUA-506 — hourly refresh via groundskeeper)
        </span>
      </h2>

      {fetchError && (
        <Card className="p-4 bg-red-50 dark:bg-red-950/30">
          <CardContent className="p-0">
            <div className="text-sm text-red-700 dark:text-red-500">
              Failed to load things_search status: {fetchError}
            </div>
          </CardContent>
        </Card>
      )}

      {!fetchError && data && !data.present && (
        <Card className="p-4 bg-gray-100 dark:bg-gray-800">
          <CardContent className="p-0">
            <div className="text-sm text-gray-700 dark:text-gray-300">
              Materialized view not present.
              {"reason" in data && data.reason ? ` ${data.reason}` : ""}
              <br />
              <span className="text-xs text-muted-foreground">
                Check that migration 0181 has been applied and the
                groundskeeper task is running.
              </span>
            </div>
          </CardContent>
        </Card>
      )}

      {!fetchError && data && data.present && (() => {
        const age = data.ageSeconds;
        const color = ageColor(age);
        return (
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <Card className={`p-4 ${color.bg}`}>
              <CardContent className="p-0">
                <div className="text-sm text-muted-foreground">Age</div>
                <div className={`text-2xl font-bold ${color.text}`}>
                  {formatAge(age)}
                </div>
                <div className="text-xs text-muted-foreground">
                  {color.label}
                </div>
              </CardContent>
            </Card>
            <Card className="p-4">
              <CardContent className="p-0">
                <div className="text-sm text-muted-foreground">
                  Last refreshed
                </div>
                <div className="text-sm font-mono">
                  {data.lastRefreshedAt
                    ? new Date(data.lastRefreshedAt).toLocaleString()
                    : "never"}
                </div>
              </CardContent>
            </Card>
            <Card className="p-4">
              <CardContent className="p-0">
                <div className="text-sm text-muted-foreground">Rows</div>
                <div className="text-2xl font-bold">
                  {data.rowCount.toLocaleString()}
                </div>
              </CardContent>
            </Card>
            <Card className="p-4">
              <CardContent className="p-0">
                <div className="text-sm text-muted-foreground">Size</div>
                <div className="text-2xl font-bold">
                  {formatBytes(data.totalBytes)}
                </div>
                <div className="text-xs text-muted-foreground">
                  heap + indexes
                </div>
              </CardContent>
            </Card>
          </div>
        );
      })()}
    </section>
  );
}
