/**
 * Framework Review dashboard — Phase 4-C of QUA-706 (QUA-710).
 *
 * Admin-only dashboard for human-in-the-loop review of frontier-safety
 * framework ingest. Two queues: pending versions (for threshold-by-
 * threshold approval before publish) and unreviewed diffs (for
 * weakening/strengthening verdicts). Both queues drive directly off
 * `safety_framework_versions.ingest_status` and
 * `framework_diffs.review_verdict` so they go to zero as the reviewer
 * works through them.
 *
 * Routing:
 *   /wiki/E2505                                  → overview (this file's
 *                                                  exported FrameworkReviewContent)
 *   /internal/framework-review/version/[id]      → VersionReviewContent
 *   /internal/framework-review/diff/[id]         → DiffReviewContent
 *
 * `/wiki/E<id>` is statically generated — searchParams don't reach it,
 * so drill-downs live as separate dynamic routes rather than query
 * params on the overview page.
 */

import {
  fetchDetailed,
  type FetchResult,
  type ApiErrorReason,
} from "@lib/wiki-server";
import type {
  RpcFrameworkReviewStatsResult,
  RpcFrameworkReviewPendingVersionsResult,
  RpcFrameworkReviewUnreviewedDiffsResult,
  RpcFrameworkReviewVersionResult,
  RpcFrameworkReviewDiffResult,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { ThresholdActions } from "./threshold-actions";
import { DiffActions } from "./diff-actions";
import { PublishButton } from "./publish-button";

const OVERVIEW_HREF = "/wiki/E2505";
const VERSION_HREF = "/internal/framework-review/version";
const DIFF_HREF = "/internal/framework-review/diff";

// ─── Overview (used by the wiki page MDX) ────────────────────────────────

export async function FrameworkReviewContent() {
  const [statsResult, versionsResult, diffsResult] = await Promise.all([
    fetchDetailed<RpcFrameworkReviewStatsResult>(
      "/api/framework-review/stats",
      { revalidate: 0 },
    ),
    fetchDetailed<RpcFrameworkReviewPendingVersionsResult>(
      "/api/framework-review/pending-versions",
      { revalidate: 0 },
    ),
    fetchDetailed<RpcFrameworkReviewUnreviewedDiffsResult>(
      "/api/framework-review/unreviewed-diffs",
      { revalidate: 0 },
    ),
  ]);

  const apiUnavailable =
    !statsResult.ok || !versionsResult.ok || !diffsResult.ok;
  const apiError = firstError(statsResult, versionsResult, diffsResult);
  const stats = statsResult.ok
    ? statsResult.data
    : {
        pendingVersions: 0,
        publishedVersions: 0,
        rejectedVersions: 0,
        unreviewedDiffs: 0,
        confirmedWeakenings: 0,
        falsePositives: 0,
      };
  const versions = versionsResult.ok ? versionsResult.data.versions : [];
  const diffs = diffsResult.ok ? diffsResult.data.diffs : [];

  return (
    <>
      <p className="text-muted-foreground text-sm leading-relaxed">
        Human-in-the-loop review queue for the frontier-safety framework
        tracker (QUA-691). Each pending version needs every extracted threshold
        approved (or skipped) before publish; each unreviewed diff needs a
        verdict before its weakening flag can surface on the public site.
      </p>

      <div className="grid grid-cols-2 md:grid-cols-3 gap-4 my-6">
        <StatCard label="Pending versions" value={stats.pendingVersions} />
        <StatCard label="Published versions" value={stats.publishedVersions} />
        <StatCard label="Rejected versions" value={stats.rejectedVersions} />
        <StatCard label="Unreviewed diffs" value={stats.unreviewedDiffs} />
        <StatCard
          label="Confirmed weakenings"
          value={stats.confirmedWeakenings}
        />
        <StatCard label="False positives" value={stats.falsePositives} />
      </div>

      {apiUnavailable && (
        <div className="rounded border border-amber-300 bg-amber-50 p-3 my-6">
          <p className="text-sm text-amber-900 font-medium">
            Wiki-server unavailable — review actions cannot be taken until it
            comes back online.
          </p>
        </div>
      )}

      <h2 className="text-lg font-semibold mt-8 mb-3">
        Pending versions ({versions.length})
      </h2>
      {versions.length === 0 ? (
        <EmptyHint label="No versions waiting for review." />
      ) : (
        <ul className="space-y-2">
          {versions.map((v) => (
            <li
              key={v.id}
              className="border border-border/60 rounded p-3 hover:border-border transition"
            >
              <a
                href={`${VERSION_HREF}/${encodeURIComponent(v.id)}`}
                className="block"
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <p className="font-medium">
                    {v.frameworkShortName ?? v.frameworkName ?? v.frameworkId}
                    {" — "}
                    <span className="font-mono text-sm">{v.versionLabel}</span>
                  </p>
                  <p className="text-xs text-muted-foreground tabular-nums">
                    {v.thresholdsReviewed}/{v.thresholdCount} thresholds reviewed
                  </p>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  {v.orgDisplayName ?? "—"} · discovered {v.discoveredDate}
                  {v.publishedDate ? ` · published ${v.publishedDate}` : ""}
                </p>
                {v.summary && (
                  <p className="text-sm mt-2 text-muted-foreground line-clamp-2">
                    {v.summary}
                  </p>
                )}
              </a>
            </li>
          ))}
        </ul>
      )}

      <h2 className="text-lg font-semibold mt-8 mb-3">
        Unreviewed diffs ({diffs.length})
      </h2>
      {diffs.length === 0 ? (
        <EmptyHint label="No diffs waiting for verdict." />
      ) : (
        <ul className="space-y-2">
          {diffs.map((d) => (
            <li
              key={d.id}
              className="border border-border/60 rounded p-3 hover:border-border transition"
            >
              <a
                href={`${DIFF_HREF}/${encodeURIComponent(d.id)}`}
                className="block"
              >
                <div className="flex items-baseline justify-between gap-3 flex-wrap">
                  <p className="font-medium">
                    {d.framework?.shortName ??
                      d.framework?.name ??
                      "Unknown framework"}
                    {": "}
                    <span className="font-mono text-sm">
                      {d.fromVersion?.versionLabel ?? d.fromVersionId} →{" "}
                      {d.toVersion?.versionLabel ?? d.toVersionId}
                    </span>
                  </p>
                  <div className="flex gap-2 text-xs">
                    {d.weakeningFlagged && (
                      <span className="px-2 py-0.5 rounded bg-red-100 text-red-700 font-mono">
                        weakening flagged
                      </span>
                    )}
                    {d.strengtheningFlagged && (
                      <span className="px-2 py-0.5 rounded bg-emerald-100 text-emerald-700 font-mono">
                        strengthening flagged
                      </span>
                    )}
                    {d.overallDirection && (
                      <span className="px-2 py-0.5 rounded bg-muted font-mono">
                        {d.overallDirection}
                      </span>
                    )}
                    <span className="px-2 py-0.5 rounded bg-muted font-mono">
                      {d.itemCount} items
                    </span>
                  </div>
                </div>
                <p className="text-sm mt-2 text-muted-foreground line-clamp-2">
                  {d.changeSummary}
                </p>
              </a>
            </li>
          ))}
        </ul>
      )}

      <DataSourceBanner
        source={apiUnavailable ? "local" : "api"}
        apiError={apiError}
      />
    </>
  );
}

// ─── Per-version review screen ───────────────────────────────────────────

export async function VersionReviewContent({
  versionId,
}: {
  versionId: string;
}) {
  const result = await fetchDetailed<RpcFrameworkReviewVersionResult>(
    `/api/framework-review/version/${encodeURIComponent(versionId)}`,
    { revalidate: 0 },
  );

  if (!result.ok) {
    return (
      <ErrorView
        backHref={OVERVIEW_HREF}
        title="Failed to load version"
        error={result.error}
      />
    );
  }

  const { version, framework, thresholds } = result.data;
  const reviewedCount = thresholds.filter((t) => t.humanReviewed).length;
  const ready = thresholds.length > 0 && reviewedCount === thresholds.length;
  const ingestStatus =
    typeof version.ingestStatus === "string"
      ? version.ingestStatus
      : "unknown";

  return (
    <main className="container mx-auto max-w-4xl px-4 py-6">
      <p>
        <a
          href={OVERVIEW_HREF}
          className="text-sm text-blue-600 hover:underline"
        >
          ← Back to review queue
        </a>
      </p>

      <h1 className="text-xl font-semibold mt-4">
        {framework?.shortName ?? framework?.name ?? "Unknown framework"} —{" "}
        <span className="font-mono">{version.versionLabel}</span>
      </h1>
      <p className="text-sm text-muted-foreground mt-1">
        {framework?.orgDisplayName ?? "—"}
        {" · "}
        ingestStatus:{" "}
        <span className="font-mono">{ingestStatus}</span>
        {version.publishedDate ? ` · published ${version.publishedDate}` : ""}
        {version.discoveredDate
          ? ` · discovered ${version.discoveredDate}`
          : ""}
      </p>

      {version.summary && (
        <p className="text-sm mt-3 leading-relaxed">{version.summary}</p>
      )}

      <div className="flex flex-wrap gap-3 mt-3 text-sm">
        {version.sourceUrl && (
          <a
            href={version.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            Source ↗
          </a>
        )}
        {version.waybackSnapshotUrl && (
          <a
            href={version.waybackSnapshotUrl}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            Wayback snapshot ↗
          </a>
        )}
        {version.pdfArchiveUrl && (
          <a
            href={version.pdfArchiveUrl}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            Archived PDF ↗
          </a>
        )}
      </div>

      {ingestStatus === "pending_review" && (
        <div className="mt-6 border-t pt-4">
          <PublishButton
            versionId={versionId}
            ready={ready}
            thresholdCount={thresholds.length}
            thresholdsReviewed={reviewedCount}
          />
        </div>
      )}

      <h2 className="text-lg font-semibold mt-8 mb-3">
        Thresholds ({thresholds.length})
      </h2>
      {thresholds.length === 0 ? (
        <EmptyHint label="No thresholds extracted from this version. The extraction may have failed; reject the version or re-run extraction." />
      ) : (
        <ul className="space-y-4">
          {thresholds.map((t) => (
            <li key={t.id} className="border border-border/60 rounded p-4">
              <div className="flex items-baseline justify-between gap-3 flex-wrap mb-2">
                <p className="font-medium">
                  <span className="text-xs px-2 py-0.5 rounded bg-muted font-mono mr-2">
                    {t.tierLabel}
                  </span>
                  {t.riskDomainLabel}{" "}
                  <span className="text-xs text-muted-foreground font-mono">
                    ({t.riskDomainCanonical})
                  </span>
                </p>
                {t.commitmentLanguage && (
                  <span className="text-xs px-2 py-0.5 rounded bg-muted font-mono">
                    {t.commitmentLanguage}
                  </span>
                )}
              </div>

              <p className="text-sm leading-relaxed mt-2">
                <span className="font-medium text-xs uppercase tracking-wide text-muted-foreground">
                  Trigger:{" "}
                </span>
                {t.triggerDescription}
              </p>

              <blockquote className="border-l-2 border-border/60 pl-3 mt-3 text-sm italic text-muted-foreground">
                <span className="font-medium not-italic text-xs uppercase tracking-wide text-foreground">
                  Source quote
                  {t.sourcePageHint ? ` (${t.sourcePageHint})` : ""}:
                </span>{" "}
                “{t.sourceQuote}”
              </blockquote>

              <div className="mt-3">
                <ThresholdActions
                  thresholdId={t.id}
                  currentVerdict={t.reviewVerdict}
                  currentNotes={t.reviewNotes}
                  fields={{
                    triggerDescription: t.triggerDescription,
                    sourceQuote: t.sourceQuote,
                    sourcePageHint: t.sourcePageHint,
                    tierLabel: t.tierLabel,
                    riskDomainLabel: t.riskDomainLabel,
                  }}
                />
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// ─── Per-diff review screen ──────────────────────────────────────────────

export async function DiffReviewContent({ diffId }: { diffId: string }) {
  const result = await fetchDetailed<RpcFrameworkReviewDiffResult>(
    `/api/framework-review/diff/${encodeURIComponent(diffId)}`,
    { revalidate: 0 },
  );

  if (!result.ok) {
    return (
      <ErrorView
        backHref={OVERVIEW_HREF}
        title="Failed to load diff"
        error={result.error}
      />
    );
  }

  const { diff, items, fromVersion, toVersion, framework } = result.data;
  const verdict =
    typeof diff.reviewVerdict === "string" ? diff.reviewVerdict : "unreviewed";

  return (
    <main className="container mx-auto max-w-4xl px-4 py-6">
      <p>
        <a
          href={OVERVIEW_HREF}
          className="text-sm text-blue-600 hover:underline"
        >
          ← Back to review queue
        </a>
      </p>

      <h1 className="text-xl font-semibold mt-4">
        {framework?.shortName ?? framework?.name ?? "Unknown framework"}:{" "}
        <span className="font-mono">
          {fromVersion?.versionLabel ?? diff.fromVersionId} →{" "}
          {toVersion?.versionLabel ?? diff.toVersionId}
        </span>
      </h1>
      <p className="text-sm text-muted-foreground mt-1">
        {framework?.orgDisplayName ?? "—"}
        {" · "}
        verdict: <span className="font-mono">{verdict}</span>
        {diff.classifiedByModel
          ? ` · classified by ${diff.classifiedByModel}`
          : ""}
      </p>

      <p className="text-sm mt-3 leading-relaxed">{diff.changeSummary}</p>

      <div className="flex flex-wrap gap-3 mt-3 text-sm">
        {fromVersion?.sourceUrl && (
          <a
            href={fromVersion.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            From source ↗
          </a>
        )}
        {toVersion?.sourceUrl && (
          <a
            href={toVersion.sourceUrl}
            target="_blank"
            rel="noreferrer"
            className="text-blue-600 hover:underline"
          >
            To source ↗
          </a>
        )}
      </div>

      <div className="mt-6">
        <DiffActions diffId={diffId} currentVerdict={verdict} />
      </div>

      <h2 className="text-lg font-semibold mt-8 mb-3">
        Change items ({items.length})
      </h2>
      {items.length === 0 ? (
        <EmptyHint label="No atomic items recorded for this diff." />
      ) : (
        <ul className="space-y-4">
          {items.map((item) => (
            <li key={item.id} className="border border-border/60 rounded p-4">
              <div className="flex items-baseline justify-between gap-3 flex-wrap">
                <p className="font-medium">
                  <span className="text-xs px-2 py-0.5 rounded bg-muted font-mono mr-2">
                    {item.changeType}
                  </span>
                  {item.riskDomainCanonical && (
                    <span className="text-xs text-muted-foreground font-mono">
                      {item.riskDomainCanonical}
                    </span>
                  )}
                </p>
                {item.classifierTag && (
                  <span
                    className={`text-xs px-2 py-0.5 rounded font-mono ${classifierColor(item.classifierTag)}`}
                  >
                    {item.classifierTag}
                  </span>
                )}
              </div>

              {item.rationale && (
                <p className="text-sm mt-2 text-muted-foreground">
                  {item.rationale}
                </p>
              )}

              <div className="grid md:grid-cols-2 gap-3 mt-3">
                <div className="border border-border/60 rounded p-2 bg-muted/30">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    Before
                  </p>
                  <pre className="text-xs whitespace-pre-wrap break-words">
                    {item.beforeSnapshot
                      ? JSON.stringify(item.beforeSnapshot, null, 2)
                      : "—"}
                  </pre>
                </div>
                <div className="border border-border/60 rounded p-2 bg-muted/30">
                  <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">
                    After
                  </p>
                  <pre className="text-xs whitespace-pre-wrap break-words">
                    {item.afterSnapshot
                      ? JSON.stringify(item.afterSnapshot, null, 2)
                      : "—"}
                  </pre>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function StatCard({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border border-border/60 p-4">
      <p className="text-xs text-muted-foreground mb-1">{label}</p>
      <p className="text-2xl font-bold tabular-nums">{value}</p>
    </div>
  );
}

function EmptyHint({ label }: { label: string }) {
  return (
    <div className="rounded border border-border/60 bg-muted/30 p-6 text-center text-sm text-muted-foreground">
      {label}
    </div>
  );
}

function classifierColor(tag: string): string {
  switch (tag) {
    case "weaker":
      return "bg-red-100 text-red-700";
    case "stronger":
      return "bg-emerald-100 text-emerald-700";
    case "rewrite_equivalent":
    case "clarification":
      return "bg-slate-200 text-slate-700";
    case "scope_narrowed":
      return "bg-amber-100 text-amber-700";
    case "scope_broadened":
      return "bg-blue-100 text-blue-700";
    default:
      return "bg-muted text-muted-foreground";
  }
}

function ErrorView({
  backHref,
  title,
  error,
}: {
  backHref: string;
  title: string;
  error: ApiErrorReason;
}) {
  return (
    <main className="container mx-auto max-w-4xl px-4 py-6">
      <p>
        <a href={backHref} className="text-sm text-blue-600 hover:underline">
          ← Back
        </a>
      </p>
      <div className="mt-4 rounded border border-red-300 bg-red-50 p-4">
        <p className="font-medium text-red-700">{title}</p>
        <p className="text-sm text-red-700 mt-1">{describeError(error)}</p>
      </div>
    </main>
  );
}

function describeError(error: ApiErrorReason): string {
  if (error.type === "not-configured") return "Wiki server is not configured.";
  if (error.type === "connection-error") return error.message;
  return `Server returned ${error.status} ${error.statusText}`;
}

function firstError<T1, T2, T3>(
  ...results: [FetchResult<T1>, FetchResult<T2>, FetchResult<T3>]
): ApiErrorReason | undefined {
  for (const r of results) {
    if (!r.ok) return r.error;
  }
  return undefined;
}
