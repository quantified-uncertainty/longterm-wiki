import "dotenv/config";
import { loadConfig } from "./config.js";
import { registerTask, setGroundskeeperAgentId } from "./scheduler.js";
import { sendDiscordNotification } from "./notify.js";
import { healthCheck } from "./tasks/health-check.js";
import { registerAsActiveAgent, sendHeartbeat } from "./wiki-server.js";
// import { issueResponder } from "./tasks/issue-responder.js"; // disabled
import { githubShadowbanCheck } from "./tasks/github-shadowban-check.js";
import { snapshotRetention } from "./tasks/snapshot-retention.js";
import { sessionSweep } from "./tasks/session-sweep.js";
import { activeAgentsSweep } from "./tasks/active-agents-sweep.js";
import { dataQualitySnapshot } from "./tasks/data-quality-snapshot.js";
import { jobWorkerHealth } from "./tasks/job-worker-health.js";
import { autoUpdateEnqueue } from "./tasks/auto-update-enqueue.js";
import { backfillSourcesEnqueue } from "./tasks/backfill-sources-enqueue.js";
import { jobFailureTriage } from "./tasks/job-failure-triage.js";
import { tablebaseScan } from "./tasks/tablebase-scan.js";
import { e2ePostDeployWatcher } from "./tasks/e2e-post-deploy-watcher.js";
import { thingsSearchRefresh } from "./tasks/things-search-refresh.js";
import { logger } from "./logger.js";

const config = loadConfig();

logger.info({
  event: "startup",
  dailyRunCap: config.dailyRunCap,
  tasks: {
    healthCheck: {
      enabled: config.tasks.healthCheck.enabled,
      schedule: config.tasks.healthCheck.schedule,
    },
    issueResponder: {
      enabled: false, // hard-disabled in code
      schedule: config.tasks.issueResponder.schedule,
    },
    githubShadowbanCheck: {
      enabled: config.tasks.githubShadowbanCheck.enabled,
      schedule: config.tasks.githubShadowbanCheck.schedule,
      usernames: config.tasks.githubShadowbanCheck.usernames,
    },
    snapshotRetention: {
      enabled: config.tasks.snapshotRetention.enabled,
      schedule: config.tasks.snapshotRetention.schedule,
      keep: config.tasks.snapshotRetention.keep,
    },
    sessionSweep: {
      enabled: config.tasks.sessionSweep.enabled,
      schedule: config.tasks.sessionSweep.schedule,
    },
    activeAgentsSweep: {
      enabled: config.tasks.activeAgentsSweep.enabled,
      schedule: config.tasks.activeAgentsSweep.schedule,
    },
    dataQualitySnapshot: {
      enabled: config.tasks.dataQualitySnapshot.enabled,
      schedule: config.tasks.dataQualitySnapshot.schedule,
    },
    jobWorkerHealth: {
      enabled: config.tasks.jobWorkerHealth.enabled,
      schedule: config.tasks.jobWorkerHealth.schedule,
    },
    autoUpdateEnqueue: {
      enabled: config.tasks.autoUpdateEnqueue.enabled,
      schedule: config.tasks.autoUpdateEnqueue.schedule,
      budget: config.tasks.autoUpdateEnqueue.budget,
      maxPages: config.tasks.autoUpdateEnqueue.maxPages,
    },
    backfillSourcesEnqueue: {
      enabled: config.tasks.backfillSourcesEnqueue.enabled,
      schedule: config.tasks.backfillSourcesEnqueue.schedule,
      limit: config.tasks.backfillSourcesEnqueue.limit,
      maxCost: config.tasks.backfillSourcesEnqueue.maxCost,
    },
    jobFailureTriage: {
      enabled: config.tasks.jobFailureTriage.enabled,
      schedule: config.tasks.jobFailureTriage.schedule,
    },
    tablebaseScan: {
      enabled: config.tasks.tablebaseScan.enabled,
      schedule: config.tasks.tablebaseScan.schedule,
    },
    e2ePostDeployWatcher: {
      enabled: config.tasks.e2ePostDeployWatcher.enabled,
      schedule: config.tasks.e2ePostDeployWatcher.schedule,
    },
    thingsSearchRefresh: {
      enabled: config.tasks.thingsSearchRefresh.enabled,
      schedule: config.tasks.thingsSearchRefresh.schedule,
    },
  },
}, "Groundskeeper starting");

// Register tasks
registerTask(
  config,
  "health-check",
  config.tasks.healthCheck.schedule,
  config.tasks.healthCheck.enabled,
  () => healthCheck(config)
);

// Issue responder disabled — was broken and repeatedly failing on issues.
// See: https://github.com/quantified-uncertainty/longterm-wiki/issues/TBD
// To re-enable, uncomment and fix the underlying issue-responder task.
// registerTask(
//   config,
//   "issue-responder",
//   config.tasks.issueResponder.schedule,
//   config.tasks.issueResponder.enabled,
//   () => issueResponder(config)
// );

registerTask(
  config,
  "github-shadowban-check",
  config.tasks.githubShadowbanCheck.schedule,
  config.tasks.githubShadowbanCheck.enabled,
  () => githubShadowbanCheck(config)
);

registerTask(
  config,
  "snapshot-retention",
  config.tasks.snapshotRetention.schedule,
  config.tasks.snapshotRetention.enabled,
  () => snapshotRetention(config)
);

registerTask(
  config,
  "session-sweep",
  config.tasks.sessionSweep.schedule,
  config.tasks.sessionSweep.enabled,
  () => sessionSweep(config)
);

registerTask(
  config,
  "active-agents-sweep",
  config.tasks.activeAgentsSweep.schedule,
  config.tasks.activeAgentsSweep.enabled,
  () => activeAgentsSweep(config)
);

registerTask(
  config,
  "data-quality-snapshot",
  config.tasks.dataQualitySnapshot.schedule,
  config.tasks.dataQualitySnapshot.enabled,
  () => dataQualitySnapshot(config)
);

registerTask(
  config,
  "job-worker-health",
  config.tasks.jobWorkerHealth.schedule,
  config.tasks.jobWorkerHealth.enabled,
  () => jobWorkerHealth(config)
);

registerTask(
  config,
  "auto-update-enqueue",
  config.tasks.autoUpdateEnqueue.schedule,
  config.tasks.autoUpdateEnqueue.enabled,
  () => autoUpdateEnqueue(config)
);

registerTask(
  config,
  "backfill-sources-enqueue",
  config.tasks.backfillSourcesEnqueue.schedule,
  config.tasks.backfillSourcesEnqueue.enabled,
  () => backfillSourcesEnqueue(config)
);

registerTask(
  config,
  "job-failure-triage",
  config.tasks.jobFailureTriage.schedule,
  config.tasks.jobFailureTriage.enabled,
  () => jobFailureTriage(config)
);

registerTask(
  config,
  "tablebase-scan",
  config.tasks.tablebaseScan.schedule,
  config.tasks.tablebaseScan.enabled,
  () => tablebaseScan(config)
);

registerTask(
  config,
  "e2e-post-deploy-watcher",
  config.tasks.e2ePostDeployWatcher.schedule,
  config.tasks.e2ePostDeployWatcher.enabled,
  () => e2ePostDeployWatcher(config)
);

registerTask(
  config,
  "things-search-refresh",
  config.tasks.thingsSearchRefresh.schedule,
  config.tasks.thingsSearchRefresh.enabled,
  () => thingsSearchRefresh(config)
);

// Register as an active agent (best-effort)
const agentId = await registerAsActiveAgent(config);
if (agentId) {
  setGroundskeeperAgentId(agentId);
  logger.info({ agentId }, "Active agent registered");

  // Send heartbeat every 5 minutes to prove we're alive.
  // Heartbeat failures are intentionally logged at debug level — they're
  // high-frequency and the wiki-server failure counter in scheduler.ts
  // already tracks connectivity issues at a higher level.
  setInterval(() => {
    sendHeartbeat(config, agentId).catch((e: unknown) =>
      logger.debug({ error: e instanceof Error ? e.message : String(e) }, "Heartbeat failed")
    );
  }, 5 * 60 * 1000);
}

await sendDiscordNotification(
  config,
  "🟢 **Groundskeeper started** — health check active, monitoring wiki server."
);

logger.info("Groundskeeper ready");
