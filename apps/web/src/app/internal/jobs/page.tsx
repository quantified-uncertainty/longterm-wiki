import {
  fetchDetailed,
  withApiFallback,
} from "@lib/wiki-server";
import { DataSourceBanner } from "@components/internal/DataSourceBanner";
import { JobsTable } from "./jobs-table";
import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Job Queue | Longterm Wiki Internal",
  description: "Background job queue status, history, and statistics.",
};

export interface JobRow {
  id: number;
  type: string;
  status: string;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  priority: number;
  retries: number;
  maxRetries: number;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  workerId: string | null;
  durationSeconds: number | null;
}

// ── API Data Loading ──────────────────────────────────────────────────────

interface ApiJobEntry {
  id: number;
  type: string;
  status: string;
  params: Record<string, unknown> | null;
  result: Record<string, unknown> | null;
  error: string | null;
  priority: number;
  retries: number;
  maxRetries: number;
  createdAt: string;
  claimedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  workerId: string | null;
}

async function loadJobsFromApi() {
  const result = await fetchDetailed<{ entries: ApiJobEntry[] }>(
    "/api/jobs?limit=200",
    { revalidate: 30 }
  );
  if (!result.ok) return result;

  return {
    ok: true as const,
    data: result.data.entries.map((j): JobRow => {
      let durationSeconds: number | null = null;
      if (j.startedAt && j.completedAt) {
        durationSeconds = Math.round(
          (new Date(j.completedAt).getTime() - new Date(j.startedAt).getTime()) / 1000
        );
      }

      return {
        ...j,
        durationSeconds,
      };
    }),
  };
}

function noLocalFallback(): JobRow[] {
  return [];
}

// ── Page Component ────────────────────────────────────────────────────────

export default async function JobsPage() {
  const { data: jobs, source, apiError } = await withApiFallback(
    loadJobsFromApi,
    noLocalFallback
  );

  const totalJobs = jobs.length;
  const pending = jobs.filter((j) => j.status === "pending").length;
  const running = jobs.filter((j) => j.status === "running" || j.status === "claimed").length;
  const completed = jobs.filter((j) => j.status === "completed").length;
  const failed = jobs.filter((j) => j.status === "failed").length;

  return (
    <article className="prose max-w-none">
      <h1>Job Queue</h1>
      <p className="text-muted-foreground">
        Background job processing queue.{" "}
        {totalJobs > 0 ? (
          <>
            <span className="font-medium text-foreground">{totalJobs}</span> jobs total:{" "}
            {pending > 0 && (
              <span className="text-muted-foreground">{pending} pending, </span>
            )}
            {running > 0 && (
              <span className="text-yellow-600 font-medium">{running} active, </span>
            )}
            <span className="text-emerald-600 font-medium">{completed} completed</span>
            {failed > 0 && (
              <span className="text-red-500 font-medium">, {failed} failed</span>
            )}
            .
          </>
        ) : (
          <>
            No jobs yet. Create one with{" "}
            <code className="text-xs">pnpm crux jobs create ping</code>.
          </>
        )}
      </p>

      {totalJobs === 0 ? (
        <div className="rounded-lg border border-border/60 p-8 text-center text-muted-foreground">
          <p className="text-lg font-medium mb-2">No jobs in the queue</p>
          <p className="text-sm">
            Jobs are created via the CLI (
            <code className="text-xs">pnpm crux jobs create</code>) or GitHub
            Actions workflows. They will appear here once created.
          </p>
        </div>
      ) : (
        <JobsTable data={jobs} />
      )}

      <DataSourceBanner source={source} apiError={apiError} />
    </article>
  );
}
