"use client";

import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

interface AutomationEntry {
  name: string;
  type: string;
  schedule: string;
  description: string;
  status: "active" | "disabled" | "manual-only";
  file: string;
}

const entries: AutomationEntry[] = [
  // -- GitHub Actions: Scheduled --
  {
    name: "Database Backup",
    type: "GHA (scheduled)",
    schedule: "Daily 02:00 UTC",
    description:
      "pg_dump to compressed artifact. Also callable as reusable workflow (e.g. pre-deploy).",
    status: "active",
    file: "database-backup.yml",
  },
  {
    name: "Wiki Server Data Export",
    type: "GHA (scheduled)",
    schedule: "Daily 04:00 UTC",
    description:
      "Exports session logs, edit logs, and job data from wiki-server API to GHA artifacts (90-day retention). Safety net for PG data.",
    status: "active",
    file: "wiki-server-export.yml",
  },
  {
    name: "Refresh Resources Snapshot",
    type: "GHA (scheduled)",
    schedule: "Daily 04:30 UTC",
    description:
      "Fetches all resources from PG, uploads as artifact. Local dev fallback when wiki-server is unavailable.",
    status: "active",
    file: "snapshot-resources.yml",
  },
  {
    name: "Auto-Rebase PRs",
    type: "GHA (scheduled)",
    schedule: "Every 4 hours",
    description:
      "Rebases open PRs onto main to surface conflicts early. Skips PRs with working labels, recent activity, or in merge queue.",
    status: "active",
    file: "auto-rebase.yml",
  },
  {
    name: "Job Worker",
    type: "GHA (scheduled + dispatch)",
    schedule: "Every 30 min + on-demand dispatch",
    description:
      "Polls wiki-server job queue, claims and executes jobs. Types: ping, citation-verify, page-improve, page-create, batch-commit, auto-update-digest, claim-verification, resource-ingest, resource-enrich.",
    status: "active",
    file: "job-worker.yml",
  },
  {
    name: "Daily Data Validation",
    type: "GHA (scheduled)",
    schedule: "Daily 07:00 UTC",
    description:
      "Runs all data validators (local YAML/MDX + server PG-backed) to catch drift in production data.",
    status: "active",
    file: "data-validation.yml",
  },
  {
    name: "Sync Entities & Facts",
    type: "GHA (push + scheduled)",
    schedule: "On push to main/production + Weekly Monday 07:00 UTC",
    description:
      "Syncs data/entities and packages/factbase YAML to PG. Weekly run catches stale entries from missed triggers.",
    status: "active",
    file: "sync-entities-facts.yml",
  },
  {
    name: "Server & API Health",
    type: "GHA (scheduled)",
    schedule: "Twice daily: 08:00 + 20:00 UTC",
    description:
      "Wiki-server availability, DB record counts, API smoke tests. Auto-creates/updates/closes GitHub issues under the 'wellness' label.",
    status: "active",
    file: "server-api-health.yml",
  },
  {
    name: "Frontend & Data Health",
    type: "GHA (scheduled)",
    schedule: "Twice daily: 08:05 + 20:05 UTC",
    description:
      "Frontend availability and data freshness checks. Staggered +5 min from server health to avoid duplicate issues.",
    status: "active",
    file: "frontend-data-health.yml",
  },
  {
    name: "CI & PR Health",
    type: "GHA (scheduled)",
    schedule: "Twice daily: 08:10 + 20:10 UTC",
    description:
      "Workflow health, job queue status, PR/issue quality. Cleans up stale working labels (agent:working, pr-patrol:working).",
    status: "active",
    file: "ci-pr-health.yml",
  },
  {
    name: "Render Quality Monitor",
    type: "GHA (scheduled)",
    schedule: "Every 6 hours",
    description:
      "Playwright render audit against production. Catches display regressions (raw numbers, JSON leaks). Auto-creates/closes GitHub issues.",
    status: "active",
    file: "render-monitor.yml",
  },
  {
    name: "Scheduled Maintenance",
    type: "GHA (scheduled)",
    schedule: "Weekdays 07:30 UTC / Sunday 09:00 / Monthly 1st 10:00",
    description:
      "Claude Code maintenance sweeps. Daily: review merged PRs. Weekly: full sweep (triage, cruft). Monthly: deep cleanup.",
    status: "active",
    file: "scheduled-maintenance.yml",
  },
  {
    name: "Sourcing",
    type: "GHA (scheduled)",
    schedule: "Weekly Monday 04:00 UTC",
    description:
      "Periodic sourcing verification of facts and records against cited URLs using Anthropic Batch API (50% cost discount).",
    status: "active",
    file: "sourcing.yml",
  },
  {
    name: "Sourcing Recheck",
    type: "GHA (scheduled)",
    schedule: "Weekly Monday 08:00 UTC",
    description:
      "Re-verifies stale sourcing verdicts. Detects when previously-verified data becomes contradicted by updated sources.",
    status: "active",
    file: "sourcing-recheck.yml",
  },
  {
    name: "Wiki Server Dead-Man-Switch",
    type: "GHA (scheduled)",
    schedule: "Weekly Monday 06:00 UTC",
    description:
      "Verifies groundskeeper daemon is alive and monitoring wiki-server health. Catches the case where groundskeeper itself goes down.",
    status: "active",
    file: "server-health-monitor.yml",
  },

  // -- GitHub Actions: Event-triggered --
  {
    name: "CI",
    type: "GHA (push/PR)",
    schedule: "On push to main/production + PRs",
    description:
      "Full CI pipeline: build data, validate gate, tests, TypeScript checks, Vercel deploy (production branch).",
    status: "active",
    file: "ci.yml",
  },
  {
    name: "Wiki Server Build & Deploy",
    type: "GHA (push)",
    schedule: "On push to production (paths: apps/wiki-server/**)",
    description:
      "Docker build, smoke test, GHCR push, ArgoCD deploy, post-deploy verification, auto-rollback on failure.",
    status: "active",
    file: "wiki-server-docker.yml",
  },
  {
    name: "Worker Build & Deploy",
    type: "GHA (push)",
    schedule: "On push to production (paths: crux/worker/**, docker/worker/**)",
    description:
      "Docker build and deploy for the K8s job worker daemon.",
    status: "active",
    file: "worker-docker.yml",
  },
  {
    name: "Groundskeeper Build & Push",
    type: "GHA (push)",
    schedule: "On push to production (paths: apps/groundskeeper/**)",
    description: "Docker image build and push to GHCR for the groundskeeper daemon.",
    status: "active",
    file: "groundskeeper-docker.yml",
  },
  {
    name: "Discord Bot Build & Push",
    type: "GHA (push)",
    schedule: "On push to production (paths: apps/discord-bot/**)",
    description: "Docker image build and push to GHCR for the Discord bot.",
    status: "active",
    file: "discord-bot-docker.yml",
  },
  {
    name: "Auto-Enqueue on Auto-Merge",
    type: "GHA (PR event)",
    schedule: "On auto_merge_enabled event",
    description:
      "When auto-merge is enabled after checks pass, enqueues PR into merge queue via GraphQL (GitHub limitation workaround).",
    status: "active",
    file: "auto-enqueue.yml",
  },
  {
    name: "Auto-Update Review Gate",
    type: "GHA (PR event)",
    schedule: "On PR open/sync/label (auto-update PRs only)",
    description:
      "Citation audit gate for auto-update PRs. Runs citation audit, fixes inaccuracies, posts summary.",
    status: "active",
    file: "auto-update-review-gate.yml",
  },
  {
    name: "E2E Post-Deploy Smoke Tests",
    type: "GHA (workflow_run)",
    schedule: "After CI completes on production",
    description: "Playwright E2E tests against live production site after deploy.",
    status: "active",
    file: "e2e-post-deploy.yml",
  },
  {
    name: "E2E PR Check",
    type: "GHA (PR)",
    schedule: "On PRs (paths: apps/web/src/**, e2e/**)",
    description:
      "Render quality audit and no-raw-IDs specs against a local build of the PR. Optional (non-required) check.",
    status: "active",
    file: "e2e-pr.yml",
  },

  // -- GitHub Actions: Manual-only --
  {
    name: "Auto-Update Wiki",
    type: "GHA (manual dispatch)",
    schedule: "Manual dispatch only (schedule disabled)",
    description:
      "News-driven automatic wiki updates. Schedule was daily 06:00 UTC, now disabled in favor of groundskeeper auto-update-enqueue task.",
    status: "disabled",
    file: "auto-update.yml",
  },
  {
    name: "Create Release PR",
    type: "GHA (manual dispatch)",
    schedule: "Manual dispatch only",
    description:
      "Creates or updates a PR from main to production with auto-generated changelog. Does not auto-merge.",
    status: "manual-only",
    file: "create-release-pr.yml",
  },
  {
    name: "Database Restore",
    type: "GHA (manual dispatch)",
    schedule: "Manual dispatch only",
    description: "Restores database from a backup artifact. Requires confirmation input.",
    status: "manual-only",
    file: "database-restore.yml",
  },
  {
    name: "Sync Data to Wiki Server",
    type: "GHA (manual dispatch)",
    schedule: "Manual dispatch only",
    description:
      "Syncs session logs and auto-update runs to wiki-server. Push-path triggers removed since data is now DB-stored.",
    status: "manual-only",
    file: "sync-data.yml",
  },
  {
    name: "Resolve Merge Conflicts",
    type: "GHA (manual dispatch)",
    schedule: "Manual dispatch only (schedule disabled)",
    description:
      "Finds conflicted PRs and resolves via two-tier approach: Sonnet API for text, Claude Code CLI for complex cases.",
    status: "disabled",
    file: "resolve-conflicts.yml",
  },
  {
    name: "Wikidata Enrichment",
    type: "GHA (manual dispatch)",
    schedule: "Manual dispatch only",
    description:
      "Enriches person entities with structured facts from Wikidata (birth year, education, etc.).",
    status: "manual-only",
    file: "wikidata-enrich.yml",
  },

  // -- Groundskeeper (K8s daemon) --
  {
    name: "GK: Health Check",
    type: "Groundskeeper",
    schedule: "Every 5 min",
    description:
      "Checks wiki-server availability and PG connectivity. Creates/closes GitHub issues with incident buffering and cooldowns.",
    status: "active",
    file: "apps/groundskeeper/src/tasks/health-check.ts",
  },
  {
    name: "GK: Job Worker Health",
    type: "Groundskeeper",
    schedule: "Every 5 min",
    description:
      "Monitors job queue health: pending backlog, failure rates, stuck jobs.",
    status: "active",
    file: "apps/groundskeeper/src/tasks/job-worker-health.ts",
  },
  {
    name: "GK: Session Sweep",
    type: "Groundskeeper",
    schedule: "Every 4 hours",
    description: "Cleans up stale agent sessions and working labels.",
    status: "active",
    file: "apps/groundskeeper/src/tasks/session-sweep.ts",
  },
  {
    name: "GK: Snapshot Retention",
    type: "Groundskeeper",
    schedule: "Daily 03:00 UTC",
    description:
      "Prunes old page snapshots beyond retention limit (default: keep 100 per page).",
    status: "active",
    file: "apps/groundskeeper/src/tasks/snapshot-retention.ts",
  },
  {
    name: "GK: Data Quality Snapshot",
    type: "Groundskeeper",
    schedule: "Daily 06:00 UTC",
    description: "Captures data quality metrics snapshot for trend tracking.",
    status: "active",
    file: "apps/groundskeeper/src/tasks/data-quality-snapshot.ts",
  },
  {
    name: "GK: Auto-Update Enqueue",
    type: "Groundskeeper",
    schedule: "Daily 06:00 UTC",
    description:
      "Enqueues auto-update jobs for wiki pages. Budget: \\$30/run, max 5 pages.",
    status: "active",
    file: "apps/groundskeeper/src/tasks/auto-update-enqueue.ts",
  },
  {
    name: "GK: Job Failure Triage",
    type: "Groundskeeper",
    schedule: "Every 6 hours",
    description:
      "Groups recent failed jobs by type and error pattern to surface recurring failures.",
    status: "active",
    file: "apps/groundskeeper/src/tasks/job-failure-triage.ts",
  },
  {
    name: "GK: GitHub Shadowban Check",
    type: "Groundskeeper",
    schedule: "Daily 09:00 UTC",
    description:
      "Checks configured GitHub usernames for shadowban status. Requires TASK_GITHUB_SHADOWBAN_CHECK_USERNAMES env.",
    status: "active",
    file: "apps/groundskeeper/src/tasks/github-shadowban-check.ts",
  },
  {
    name: "GK: Issue Responder",
    type: "Groundskeeper",
    schedule: "Every 15 min (disabled)",
    description: "Auto-responds to new GitHub issues. Hard-disabled in code due to repeated failures.",
    status: "disabled",
    file: "apps/groundskeeper/src/tasks/issue-responder.ts",
  },
  {
    name: "GK: TableBase Scan",
    type: "Groundskeeper",
    schedule: "Daily 05:00 UTC",
    description:
      "Scans TableBase records for sourcing coverage and writes scanner-results artifacts used by the coverage dashboard.",
    status: "active",
    file: "apps/groundskeeper/src/tasks/tablebase-scan.ts",
  },

  // -- K8s Long-Running Services --
  {
    name: "Wiki Server (Hono)",
    type: "K8s Deployment",
    schedule: "Always-on",
    description:
      "Hono API server (PG-backed). Serves wiki-server API, job queue, sync endpoints. Deployed via ArgoCD.",
    status: "active",
    file: "apps/wiki-server/",
  },
  {
    name: "Job Worker Daemon",
    type: "K8s Deployment",
    schedule: "Always-on (poll mode)",
    description:
      "Long-lived Node.js worker that polls the job queue with concurrency control, memory watchdog, and health probes.",
    status: "active",
    file: "crux/worker/run.ts",
  },
  {
    name: "Groundskeeper Daemon",
    type: "K8s Deployment",
    schedule: "Always-on (cron-based tasks)",
    description:
      "Node.js daemon running scheduled tasks via node-cron. Circuit breaker per task (3 failures), half-open recovery, Discord notifications.",
    status: "active",
    file: "apps/groundskeeper/",
  },
  {
    name: "Discord Bot",
    type: "K8s Deployment",
    schedule: "Always-on",
    description:
      "Discord.js bot responding to @mention (wiki Q&A via Anthropic API) and /ask (Claude Code CLI). Rate-limited per user.",
    status: "active",
    file: "apps/discord-bot/",
  },

  // -- Vercel --
  {
    name: "Next.js Frontend (Vercel)",
    type: "Vercel",
    schedule: "Deploy on push to main + production",
    description:
      "Next.js 15 frontend. Main branch previews, production branch serves longtermwiki.com. Triggered by CI deploy hook.",
    status: "active",
    file: "apps/web/",
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function statusBadge(status: AutomationEntry["status"]): React.ReactNode {
  const styles: Record<AutomationEntry["status"], string> = {
    active: "bg-green-100 text-green-800 dark:bg-green-900/40 dark:text-green-300",
    disabled: "bg-red-100 text-red-800 dark:bg-red-900/40 dark:text-red-300",
    "manual-only":
      "bg-yellow-100 text-yellow-800 dark:bg-yellow-900/40 dark:text-yellow-300",
  };
  const labels: Record<AutomationEntry["status"], string> = {
    active: "Active",
    disabled: "Disabled",
    "manual-only": "Manual",
  };
  return (
    <span
      className={`inline-block rounded-full px-2 py-0.5 text-xs font-medium ${styles[status]}`}
    >
      {labels[status]}
    </span>
  );
}

// Group entries by logical section
const groups = [
  {
    title: "GitHub Actions -- Scheduled",
    entries: entries.filter(
      (e) =>
        e.type.startsWith("GHA (scheduled") && e.status === "active"
    ),
  },
  {
    title: "GitHub Actions -- Event-Triggered",
    entries: entries.filter(
      (e) =>
        (e.type.startsWith("GHA (push") ||
          e.type.startsWith("GHA (PR") ||
          e.type.startsWith("GHA (workflow")) &&
        e.status === "active"
    ),
  },
  {
    title: "GitHub Actions -- Manual / Disabled",
    entries: entries.filter(
      (e) =>
        e.type.startsWith("GHA") &&
        (e.status === "disabled" || e.status === "manual-only")
    ),
  },
  {
    title: "Groundskeeper Tasks (K8s Daemon)",
    entries: entries.filter((e) => e.type === "Groundskeeper"),
  },
  {
    title: "K8s Long-Running Services",
    entries: entries.filter((e) => e.type === "K8s Deployment"),
  },
  {
    title: "External Hosting",
    entries: entries.filter((e) => e.type === "Vercel"),
  },
];

// ---------------------------------------------------------------------------
// Summary stats
// ---------------------------------------------------------------------------

const totalActive = entries.filter((e) => e.status === "active").length;
const totalDisabled = entries.filter((e) => e.status === "disabled").length;
const totalManual = entries.filter((e) => e.status === "manual-only").length;
const ghaScheduled = entries.filter(
  (e) => e.type.startsWith("GHA (scheduled") && e.status === "active"
).length;
const gkTasks = entries.filter((e) => e.type === "Groundskeeper").length;
const gkActive = entries.filter(
  (e) => e.type === "Groundskeeper" && e.status === "active"
).length;

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function AutomationLandscapeContent() {
  return (
    <div className="space-y-8">
      {/* Summary */}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <StatCard label="Total processes" value={entries.length} />
        <StatCard label="Active" value={totalActive} />
        <StatCard label="Disabled" value={totalDisabled} />
        <StatCard label="Manual-only" value={totalManual} />
      </div>

      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <StatCard label="GHA scheduled" value={ghaScheduled} />
        <StatCard label="GK tasks (active)" value={`${gkActive}/${gkTasks}`} />
        <StatCard label="K8s services" value={entries.filter((e) => e.type === "K8s Deployment").length} />
      </div>

      {/* Pause notice */}
      <div className="rounded-md border border-yellow-200 bg-yellow-50 p-3 text-sm text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/20 dark:text-yellow-200">
        All scheduled GitHub Actions respect the <code>AUTOMATION_PAUSED</code> repository variable.
        Set it to <code>true</code> to pause all automation (e.g., during incident response).
        Resume with <code>pnpm crux ci resume-actions</code>.
      </div>

      {/* Groups */}
      {groups.map((group) => (
        <section key={group.title}>
          <h3 className="mb-3 text-lg font-semibold">{group.title}</h3>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="min-w-[180px]">Name</TableHead>
                  <TableHead className="min-w-[200px]">Schedule</TableHead>
                  <TableHead>Description</TableHead>
                  <TableHead className="min-w-[80px]">Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {group.entries.map((entry) => (
                  <TableRow key={entry.name}>
                    <TableCell className="font-medium">{entry.name}</TableCell>
                    <TableCell className="text-sm text-muted-foreground">
                      {entry.schedule}
                    </TableCell>
                    <TableCell className="text-sm">{entry.description}</TableCell>
                    <TableCell>{statusBadge(entry.status)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      ))}

      {/* Architecture notes */}
      <section>
        <h3 className="mb-3 text-lg font-semibold">Architecture Notes</h3>
        <div className="space-y-4 text-sm">
          <div>
            <h4 className="font-medium">Execution Tiers</h4>
            <ul className="mt-1 list-inside list-disc space-y-1 text-muted-foreground">
              <li>
                <strong>GitHub Actions</strong> -- ephemeral runners for CI, scheduled jobs, and on-demand
                work. Job Worker GHA polls every 30 min as backup; the K8s worker daemon handles real-time
                dispatch.
              </li>
              <li>
                <strong>K8s (ArgoCD)</strong> -- long-running services: wiki-server, job worker daemon,
                groundskeeper, Discord bot. Managed via Helm charts in the ops repo.
              </li>
              <li>
                <strong>Vercel</strong> -- Next.js frontend. Deploy hooks triggered by CI on production branch.
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-medium">Key Overlaps</h4>
            <ul className="mt-1 list-inside list-disc space-y-1 text-muted-foreground">
              <li>
                Health monitoring has two layers: Groundskeeper checks every 5 min (primary), GHA
                Dead-Man-Switch checks weekly (catches groundskeeper failure).
              </li>
              <li>
                Auto-update has two paths: Groundskeeper enqueues jobs daily (active), GHA auto-update
                workflow is disabled (was the original mechanism).
              </li>
              <li>
                Job execution has two paths: K8s worker daemon (always-on, real-time) and GHA Job Worker
                (polls every 30 min as fallback).
              </li>
            </ul>
          </div>
          <div>
            <h4 className="font-medium">Daily Timeline (UTC)</h4>
            <ul className="mt-1 list-inside list-disc space-y-1 text-muted-foreground">
              <li>02:00 -- Database backup</li>
              <li>03:00 -- Snapshot retention cleanup (GK)</li>
              <li>04:00 -- Wiki-server data export + Source-check (Mon)</li>
              <li>04:30 -- Resources snapshot refresh</li>
              <li>05:00 -- TableBase scan (GK)</li>
              <li>06:00 -- Data quality snapshot (GK) + Auto-update enqueue (GK)</li>
              <li>07:00 -- Daily data validation + Entity/fact sync (Mon)</li>
              <li>07:30 -- Scheduled maintenance (weekdays)</li>
              <li>08:00 -- Server health + Source-check recheck (Mon) + Dead-man-switch (Mon)</li>
              <li>08:05 -- Frontend health</li>
              <li>08:10 -- CI & PR health</li>
              <li>09:00 -- GitHub shadowban check (GK) + Weekly maintenance (Sun)</li>
              <li>20:00 -- Server health (second run)</li>
              <li>20:05 -- Frontend health (second run)</li>
              <li>20:10 -- CI & PR health (second run)</li>
            </ul>
          </div>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Stat card
// ---------------------------------------------------------------------------

function StatCard({
  label,
  value,
}: {
  label: string;
  value: string | number;
}) {
  return (
    <div className="rounded-lg border bg-card p-3 text-center">
      <div className="text-2xl font-bold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
