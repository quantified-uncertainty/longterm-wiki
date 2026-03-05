/**
 * Job Queue Health Check
 *
 * Fetches /api/jobs/stats from wiki-server and checks for:
 *   - High failure rates (>50% with >5 total jobs of that type)
 *   - Large pending backlogs (>100 pending for any single type)
 */

import type { CheckResult } from '../health-check.ts';

interface JobTypeStats {
  byStatus: Record<string, number>;
  failureRate?: number;
  avgDurationMs?: number;
}

interface JobStatsResponse {
  totalJobs?: number;
  byType?: Record<string, JobTypeStats>;
}

export async function checkJobQueue(): Promise<CheckResult> {
  const name = 'Job queue';
  const detail: string[] = [];
  const failures: string[] = [];

  const serverUrl = process.env.LONGTERMWIKI_SERVER_URL ?? '';
  const apiKey = process.env.LONGTERMWIKI_SERVER_API_KEY ?? '';

  if (!serverUrl) {
    return { name, ok: true, summary: 'Skipped (LONGTERMWIKI_SERVER_URL not set)' };
  }

  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;

  let data: JobStatsResponse;
  try {
    const res = await fetch(`${serverUrl}/api/jobs/stats`, {
      headers,
      signal: AbortSignal.timeout(15_000),
    });

    if (!res.ok) {
      return {
        name,
        ok: true,
        summary: `Skipped (HTTP ${res.status} from /api/jobs/stats)`,
        detail: [`Jobs stats endpoint returned HTTP ${res.status}`],
      };
    }

    data = (await res.json()) as JobStatsResponse;
  } catch (err) {
    return {
      name,
      ok: true,
      summary: 'Skipped (jobs stats endpoint unreachable)',
      detail: [`Error: ${err instanceof Error ? err.message : String(err)}`],
    };
  }

  const totalJobs = data.totalJobs ?? 0;
  detail.push(`Total jobs: ${totalJobs}`);

  const byType = data.byType ?? {};

  for (const [jobType, stats] of Object.entries(byType)) {
    const statusCounts = stats.byStatus ?? {};
    const pending = statusCounts['pending'] ?? 0;
    const running = statusCounts['running'] ?? 0;
    const failed = statusCounts['failed'] ?? 0;
    const failureRate = stats.failureRate ?? 0;
    const avgMs = stats.avgDurationMs ?? 'N/A';
    const failurePct = Math.round(failureRate * 100);

    // Total across all statuses for this job type
    const totalType = Object.values(statusCounts).reduce((sum, n) => sum + n, 0);

    if (failurePct > 50 && totalType > 5) {
      detail.push(`WARN  ${jobType}: ${failurePct}% failure rate (${failed} failed)`);
      failures.push(`${jobType}: ${failurePct}% failure rate`);
    } else {
      detail.push(
        `PASS  ${jobType}: pending=${pending} running=${running} failed=${failed} failure=${failurePct}% avg=${avgMs}ms`,
      );
    }

    // Alert on large pending backlog
    if (pending > 100) {
      detail.push(`WARN  ${jobType}: ${pending} pending jobs (backlog)`);
      failures.push(`${jobType}: ${pending} pending jobs (large backlog)`);
    }
  }

  if (failures.length > 0) {
    return { name, ok: false, summary: 'Job queue issues detected', detail };
  }
  return { name, ok: true, summary: `Job queue healthy (${totalJobs} total jobs)`, detail };
}
