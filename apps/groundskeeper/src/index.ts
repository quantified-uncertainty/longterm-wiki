import "dotenv/config";
import { loadConfig } from "./config.js";
import { registerTask, setGroundskeeperAgentId } from "./scheduler.js";
import { sendDiscordNotification } from "./notify.js";
import { healthCheck } from "./tasks/health-check.js";
import { registerAsActiveAgent, sendHeartbeat } from "./wiki-server.js";
import { issueResponder } from "./tasks/issue-responder.js";
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
      enabled: config.tasks.issueResponder.enabled,
      schedule: config.tasks.issueResponder.schedule,
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

registerTask(
  config,
  "issue-responder",
  config.tasks.issueResponder.schedule,
  config.tasks.issueResponder.enabled,
  () => issueResponder(config)
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
