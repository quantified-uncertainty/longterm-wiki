import {
  IdFormatAuditSchema,
  ID_FORMAT_BUCKET_NAMES,
  ID_FORMAT_SOURCE_TABLES,
  type IdFormatAudit,
  type IdFormatBucketName,
  type IdFormatSourceTableName,
} from "@wiki-server/api-types";
import { SectionErrorBoundary } from "@/components/shared/SectionErrorBoundary";
import type { RpcDataQualityHistoryResult } from "@lib/wiki-server";

type SnapshotLike = RpcDataQualityHistoryResult["snapshots"][number];

const BUCKET_LABELS: Record<IdFormatBucketName, string> = {
  canonical_f: "Canonical f_",
  canonical_sid: "Canonical sid_",
  legacy_hex8: "Legacy hex8",
  legacy_alnum10: "Legacy alnum10",
  legacy_hex16: "Legacy hex16",
  other: "Other",
};

const CANONICAL_BUCKETS: ReadonlySet<IdFormatBucketName> = new Set([
  "canonical_f",
  "canonical_sid",
]);
const LEGACY_BUCKETS: ReadonlySet<IdFormatBucketName> = new Set([
  "legacy_hex8",
  "legacy_alnum10",
  "legacy_hex16",
]);

function bucketColor(bucket: IdFormatBucketName): string {
  if (CANONICAL_BUCKETS.has(bucket)) return "text-green-600";
  if (LEGACY_BUCKETS.has(bucket)) return "text-yellow-700";
  return "text-gray-500";
}

export function parseAudit(snapshot: SnapshotLike): IdFormatAudit | null {
  const extra = snapshot.extra as Record<string, unknown> | null | undefined;
  if (!extra || typeof extra !== "object") return null;
  const raw = (extra as { idFormatAudit?: unknown }).idFormatAudit;
  if (!raw) return null;
  const parsed = IdFormatAuditSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

export interface RegressionAlert {
  severity: "yellow" | "red";
  bucket: IdFormatBucketName;
  delta: number;
  deltaPct: number | null;
}

export function computeAlerts(
  latest: IdFormatAudit,
  previous: IdFormatAudit | null,
): RegressionAlert[] {
  if (!previous) return [];
  const alerts: RegressionAlert[] = [];
  for (const b of ID_FORMAT_BUCKET_NAMES) {
    if (CANONICAL_BUCKETS.has(b)) continue; // canonical growth is good
    const cur = latest.totals[b];
    const prev = previous.totals[b];
    const delta = cur - prev;
    if (delta <= 0) continue;
    const deltaPct = prev > 0 ? (delta / prev) * 100 : null;
    const severity: "red" | "yellow" =
      delta >= 10 || (deltaPct !== null && deltaPct >= 25) ? "red" : "yellow";
    alerts.push({ severity, bucket: b, delta, deltaPct });
  }
  return alerts;
}

function Sparkline({ values }: { values: number[] }) {
  const min = Math.min(...values);
  const max = Math.max(...values);
  const range = max - min || 1;
  const points = values
    .map((v, i) => {
      const x = (i / Math.max(values.length - 1, 1)) * 100;
      const y = 20 - ((v - min) / range) * 18;
      return `${x},${y}`;
    })
    .join(" ");
  return (
    <svg
      viewBox="0 0 100 20"
      className="w-full h-5"
      preserveAspectRatio="none"
      aria-hidden
    >
      <polyline
        points={points}
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}

function formatNumber(n: number): string {
  return n.toLocaleString();
}

function IdFormatSectionInner({ snapshots }: { snapshots: SnapshotLike[] }) {
  const audits = snapshots
    .map((s) => ({ at: s.capturedAt, audit: parseAudit(s) }))
    .filter((x): x is { at: string; audit: IdFormatAudit } => x.audit !== null);

  if (audits.length === 0) {
    return (
      <section>
        <h2 className="text-lg font-semibold mb-2">ID Format Audit</h2>
        <p className="text-sm text-muted-foreground">
          ID format audit will populate on the next 06:00 UTC data-quality
          snapshot. See QUA-407 for context.
        </p>
      </section>
    );
  }

  const latest = audits[0].audit;
  const previous = audits[1]?.audit ?? null;
  const alerts = computeAlerts(latest, previous);
  const redAlerts = alerts.filter((a) => a.severity === "red");
  const yellowAlerts = alerts.filter((a) => a.severity === "yellow");

  const historyCount = audits.length;
  const showSparkline = historyCount >= 7;
  const legacyHistory = showSparkline
    ? audits
        .slice(0, 30)
        .reverse()
        .map((a) =>
          Array.from(LEGACY_BUCKETS).reduce(
            (sum, b) => sum + a.audit.totals[b],
            0,
          ),
        )
    : [];

  return (
    <section>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold">
          ID Format Audit{" "}
          <span className="text-sm font-normal text-muted-foreground">
            (scanned {new Date(latest.scannedAt).toLocaleString()})
          </span>
        </h2>
      </div>

      {redAlerts.length > 0 && (
        <div className="mb-4 rounded-md border border-red-300 bg-red-50 p-3 text-sm text-red-900">
          <strong>Legacy ID regression detected.</strong>{" "}
          {redAlerts
            .map(
              (a) =>
                `${BUCKET_LABELS[a.bucket]} +${a.delta}${a.deltaPct ? ` (+${a.deltaPct.toFixed(0)}%)` : ""}`,
            )
            .join(", ")}
          . See QUA-43 for the underlying cleanup.
        </div>
      )}

      <div className="overflow-x-auto">
        <table className="w-full text-sm border-collapse">
          <thead>
            <tr className="border-b">
              <th className="text-left py-2 pr-4 font-medium">Source table</th>
              {ID_FORMAT_BUCKET_NAMES.map((b) => (
                <th key={b} className="text-right py-2 px-2 font-medium">
                  {BUCKET_LABELS[b]}
                </th>
              ))}
              <th className="text-right py-2 pl-2 font-medium">Total</th>
            </tr>
          </thead>
          <tbody>
            {ID_FORMAT_SOURCE_TABLES.map((t: IdFormatSourceTableName) => {
              const row = latest.bySourceTable[t];
              const total = ID_FORMAT_BUCKET_NAMES.reduce(
                (s, b) => s + row[b],
                0,
              );
              return (
                <tr key={t} className="border-b">
                  <td className="py-2 pr-4 font-mono">{t}</td>
                  {ID_FORMAT_BUCKET_NAMES.map((b) => {
                    const count = row[b];
                    const yellow = yellowAlerts.find(
                      (a) => a.bucket === b,
                    );
                    return (
                      <td
                        key={b}
                        className={`text-right py-2 px-2 ${bucketColor(b)}`}
                      >
                        {formatNumber(count)}
                        {yellow && t === "facts" && (
                          <span className="ml-1 text-xs text-yellow-700">
                            +{yellow.delta}
                          </span>
                        )}
                      </td>
                    );
                  })}
                  <td className="text-right py-2 pl-2 font-semibold">
                    {formatNumber(total)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {showSparkline ? (
        <div className="mt-4">
          <div className="text-xs text-muted-foreground mb-1">
            Legacy total, last {legacyHistory.length} snapshots
          </div>
          <div className="text-yellow-700 max-w-xs">
            <Sparkline values={legacyHistory} />
          </div>
        </div>
      ) : (
        <div className="mt-4 text-xs text-muted-foreground">
          Sparkline enabled after 7 snapshots ({historyCount}/7).
        </div>
      )}
    </section>
  );
}

export function IdFormatSection({
  snapshots,
}: {
  snapshots: SnapshotLike[];
}) {
  return (
    <SectionErrorBoundary
      fallback={
        <section>
          <h2 className="text-lg font-semibold mb-2">ID Format Audit</h2>
          <p className="text-sm text-muted-foreground">
            ID format audit unavailable — see QUA-407.
          </p>
        </section>
      }
    >
      <IdFormatSectionInner snapshots={snapshots} />
    </SectionErrorBoundary>
  );
}
