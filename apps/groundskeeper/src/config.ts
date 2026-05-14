export interface TaskConfig {
  enabled: boolean;
  schedule: string; // cron expression
}

export interface ShadowbanCheckConfig extends TaskConfig {
  usernames: string[];
}

export interface SnapshotRetentionConfig extends TaskConfig {
  /** Number of snapshots to keep per page (default: 30). */
  keep: number;
}

export interface AutoUpdateEnqueueConfig extends TaskConfig {
  /** Max dollars per auto-update run (default: 30). */
  budget: number;
  /** Max pages per auto-update run (default: 5). */
  maxPages: number;
}

export interface BackfillSourcesEnqueueConfig extends TaskConfig {
  /** Max records per table per run (default: 100). */
  limit: number;
  /** Max dollars per backfill run (default: 5). */
  maxCost: number;
}

export interface Config {
  githubAppId: string;
  githubInstallationId: string;
  githubAppPrivateKey: string;
  githubRepo: string;
  wikiServerUrl: string;
  discordWebhookUrl: string;
  dailyRunCap: number;
  runLogPath: string;
  circuitBreakerCooldownMs: number;
  tasks: {
    healthCheck: TaskConfig;
    issueResponder: TaskConfig;
    githubShadowbanCheck: ShadowbanCheckConfig;
    snapshotRetention: SnapshotRetentionConfig;
    sessionSweep: TaskConfig;
    activeAgentsSweep: TaskConfig;
    dataQualitySnapshot: TaskConfig;
    jobWorkerHealth: TaskConfig;
    autoUpdateEnqueue: AutoUpdateEnqueueConfig;
    backfillSourcesEnqueue: BackfillSourcesEnqueueConfig;
    jobFailureTriage: TaskConfig;
    tablebaseScan: TaskConfig;
    e2ePostDeployWatcher: TaskConfig;
    thingsSearchRefresh: TaskConfig;
  };
}

function envOrDie(name: string): string {
  const value = process.env[name];
  if (!value) {
    // Use console.error here intentionally: logger may not be initialized
    // yet since config is loaded first during startup.
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

function envBool(name: string, defaultValue: boolean): boolean {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  return value === "true" || value === "1";
}

function envInt(name: string, defaultValue: number): number {
  const value = process.env[name];
  if (value === undefined) return defaultValue;
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) return defaultValue;
  return parsed;
}

export function loadConfig(): Config {
  return {
    githubAppId: envOrDie("GITHUB_APP_ID"),
    githubInstallationId: envOrDie("GITHUB_INSTALLATION_ID"),
    githubAppPrivateKey: envOrDie("GITHUB_APP_PRIVATE_KEY"),
    githubRepo: envOrDie("GITHUB_REPO"),
    wikiServerUrl: envOrDie("WIKI_SERVER_URL"),
    discordWebhookUrl: envOrDie("DISCORD_WEBHOOK_URL"),
    dailyRunCap: envInt("DAILY_RUN_CAP", 20),
    runLogPath: process.env["RUN_LOG_PATH"] ?? "/data/run-log.json",
    circuitBreakerCooldownMs: envInt("CIRCUIT_BREAKER_COOLDOWN_MS", 1_800_000),
    tasks: {
      healthCheck: {
        enabled: envBool("TASK_HEALTH_CHECK_ENABLED", true),
        schedule: process.env["TASK_HEALTH_CHECK_SCHEDULE"] ?? "*/5 * * * *",
      },
      issueResponder: {
        enabled: envBool("TASK_ISSUE_RESPONDER_ENABLED", false),
        schedule:
          process.env["TASK_ISSUE_RESPONDER_SCHEDULE"] ?? "*/15 * * * *",
      },
      githubShadowbanCheck: {
        enabled: envBool("TASK_GITHUB_SHADOWBAN_CHECK_ENABLED", true),
        schedule:
          process.env["TASK_GITHUB_SHADOWBAN_CHECK_SCHEDULE"] ?? "0 9 * * *",
        // Default to empty — no dedicated bot account exists for this project.
        // Populate TASK_GITHUB_SHADOWBAN_CHECK_USERNAMES (comma-separated) if
        // a custom GitHub automation account is created and needs monitoring.
        // Previously hardcoded "quri-bot" which does not exist on GitHub,
        // causing every run to return 404 -> "banned" -> success: false.
        usernames: (process.env["TASK_GITHUB_SHADOWBAN_CHECK_USERNAMES"] ?? "")
          .split(",")
          .map((u) => u.trim())
          .filter(Boolean),
      },
      snapshotRetention: {
        enabled: envBool("TASK_SNAPSHOT_RETENTION_ENABLED", true),
        schedule:
          process.env["TASK_SNAPSHOT_RETENTION_SCHEDULE"] ?? "0 3 * * *", // daily at 3am UTC
        keep: envInt("TASK_SNAPSHOT_RETENTION_KEEP", 30),
      },
      sessionSweep: {
        enabled: envBool("TASK_SESSION_SWEEP_ENABLED", true),
        schedule:
          process.env["TASK_SESSION_SWEEP_SCHEDULE"] ?? "0 */4 * * *", // every 4 hours
      },
      activeAgentsSweep: {
        // QUA-584: parallel sweep for the active_agents table (live agent
        // registry). The session-sweep task only handles agent_sessions; the
        // active_agents table accumulated 77/81 phantom rows because no
        // sweep was scheduled. 30 min cadence with a 60 min stale threshold
        // means abandoned sessions are reflected in dashboards within an hour.
        enabled: envBool("TASK_ACTIVE_AGENTS_SWEEP_ENABLED", true),
        schedule:
          process.env["TASK_ACTIVE_AGENTS_SWEEP_SCHEDULE"] ?? "*/30 * * * *", // every 30 min
      },
      dataQualitySnapshot: {
        enabled: envBool("TASK_DATA_QUALITY_SNAPSHOT_ENABLED", true),
        schedule:
          process.env["TASK_DATA_QUALITY_SNAPSHOT_SCHEDULE"] ?? "0 6 * * *", // daily at 6am UTC
      },
      jobWorkerHealth: {
        enabled: envBool("TASK_JOB_WORKER_HEALTH_ENABLED", true),
        schedule:
          process.env["TASK_JOB_WORKER_HEALTH_SCHEDULE"] ?? "*/5 * * * *", // every 5 minutes
      },
      autoUpdateEnqueue: {
        enabled: envBool("TASK_AUTO_UPDATE_ENQUEUE_ENABLED", true),
        schedule:
          process.env["TASK_AUTO_UPDATE_ENQUEUE_SCHEDULE"] ?? "0 6 * * *", // daily at 6am UTC
        budget: envInt("TASK_AUTO_UPDATE_ENQUEUE_BUDGET", 30),
        maxPages: envInt("TASK_AUTO_UPDATE_ENQUEUE_MAX_PAGES", 5),
      },
      backfillSourcesEnqueue: {
        enabled: envBool("TASK_BACKFILL_SOURCES_ENQUEUE_ENABLED", true),
        schedule:
          process.env["TASK_BACKFILL_SOURCES_ENQUEUE_SCHEDULE"] ?? "0 2 * * *", // daily at 2am UTC
        limit: envInt("TASK_BACKFILL_SOURCES_ENQUEUE_LIMIT", 100),
        maxCost: envInt("TASK_BACKFILL_SOURCES_ENQUEUE_MAX_COST", 5),
      },
      jobFailureTriage: {
        enabled: envBool("TASK_JOB_FAILURE_TRIAGE_ENABLED", true),
        schedule:
          process.env["TASK_JOB_FAILURE_TRIAGE_SCHEDULE"] ?? "0 */6 * * *", // every 6 hours
      },
      tablebaseScan: {
        enabled: envBool("TASK_TABLEBASE_SCAN_ENABLED", true),
        schedule:
          process.env["TASK_TABLEBASE_SCAN_SCHEDULE"] ?? "0 5 * * *", // daily at 5am UTC
      },
      e2ePostDeployWatcher: {
        enabled: envBool("TASK_E2E_POST_DEPLOY_WATCHER_ENABLED", true),
        schedule:
          process.env["TASK_E2E_POST_DEPLOY_WATCHER_SCHEDULE"] ?? "15 * * * *", // hourly at :15
      },
      thingsSearchRefresh: {
        // QUA-506 D3: hourly REFRESH MV CONCURRENTLY. Offset from :00 to :25
        // so it doesn't collide with e2e-post-deploy-watcher (:15) and
        // leaves headroom for hourly analytics tasks that run on the hour.
        enabled: envBool("TASK_THINGS_SEARCH_REFRESH_ENABLED", true),
        schedule:
          process.env["TASK_THINGS_SEARCH_REFRESH_SCHEDULE"] ?? "25 * * * *",
      },
    },
  };
}
