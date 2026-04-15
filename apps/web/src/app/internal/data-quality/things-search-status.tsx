import { Card, CardContent } from "@/components/ui/card";
import {
  getThingsSearchRpcClient,
  type RpcThingsSearchStatusResult,
} from "@lib/wiki-server";

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes)) return "—";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatCount(n: number): string {
  return Number.isFinite(n) ? n.toLocaleString() : "—";
}

function formatDuration(seconds: number | null): string {
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

type AgeStatus = "unknown" | "healthy" | "warning" | "stale";

// 90m = 1.5× hourly cron + jitter/retry slack; 3h = ~3× = alert.
const AGE_STYLES: Record<AgeStatus, { bg: string; text: string; label: string }> = {
  unknown: {
    bg: "bg-gray-100 dark:bg-gray-800",
    text: "text-gray-700 dark:text-gray-300",
    label: "unknown",
  },
  healthy: {
    bg: "bg-green-50 dark:bg-green-950/30",
    text: "text-green-700 dark:text-green-400",
    label: "healthy",
  },
  warning: {
    bg: "bg-yellow-50 dark:bg-yellow-950/30",
    text: "text-yellow-700 dark:text-yellow-500",
    label: "warning",
  },
  stale: {
    bg: "bg-red-50 dark:bg-red-950/30",
    text: "text-red-700 dark:text-red-500",
    label: "stale",
  },
};

function ageStatus(seconds: number | null): AgeStatus {
  if (seconds == null) return "unknown";
  if (seconds < 90 * 60) return "healthy";
  if (seconds < 3 * 3600) return "warning";
  return "stale";
}

function PresentStats({ data }: { data: Extract<RpcThingsSearchStatusResult, { present: true }> }) {
  const style = AGE_STYLES[ageStatus(data.ageSeconds)];
  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      <Card className={`p-4 ${style.bg}`}>
        <CardContent className="p-0">
          <div className="text-sm text-muted-foreground">Age</div>
          <div className={`text-2xl font-bold ${style.text}`}>
            {formatDuration(data.ageSeconds)}
          </div>
          <div className="text-xs text-muted-foreground">{style.label}</div>
        </CardContent>
      </Card>
      <Card className="p-4">
        <CardContent className="p-0">
          <div className="text-sm text-muted-foreground">Last refreshed</div>
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
          <div className="text-2xl font-bold">{formatCount(data.rowCount)}</div>
        </CardContent>
      </Card>
      <Card className="p-4">
        <CardContent className="p-0">
          <div className="text-sm text-muted-foreground">Size</div>
          <div className="text-2xl font-bold">{formatBytes(data.totalBytes)}</div>
          <div className="text-xs text-muted-foreground">heap + indexes</div>
        </CardContent>
      </Card>
    </div>
  );
}

export async function ThingsSearchStatusSection() {
  const client = getThingsSearchRpcClient();
  if (!client) return null;

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

      {!fetchError && data && data.present && <PresentStats data={data} />}
    </section>
  );
}
