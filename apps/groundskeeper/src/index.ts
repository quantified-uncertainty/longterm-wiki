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
