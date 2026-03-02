export interface TaskConfig {
  enabled: boolean;
  schedule: string; // cron expression
}

export interface ShadowbanCheckConfig extends TaskConfig {
  usernames: string[];
}

export interface SnapshotRetentionConfig extends TaskConfig {
  /** Number of snapshots to keep per page (default: 100). */
  keep: number;
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
        usernames: ["quri-bot"],
      },
      snapshotRetention: {
        enabled: envBool("TASK_SNAPSHOT_RETENTION_ENABLED", true),
        schedule:
          process.env["TASK_SNAPSHOT_RETENTION_SCHEDULE"] ?? "0 3 * * *", // daily at 3am UTC
        keep: envInt("TASK_SNAPSHOT_RETENTION_KEEP", 100),
      },
    },
  };
}
