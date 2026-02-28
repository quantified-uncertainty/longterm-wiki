import "dotenv/config";
import { loadConfig } from "./config.js";
import { registerTask } from "./scheduler.js";
import { sendDiscordNotification } from "./notify.js";
import { healthCheck } from "./tasks/health-check.js";
import { resolveConflicts } from "./tasks/resolve-conflicts.js";
import { codeReview } from "./tasks/code-review.js";

const config = loadConfig();

console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "startup",
    dailyRunCap: config.dailyRunCap,
    tasks: {
      healthCheck: {
        enabled: config.tasks.healthCheck.enabled,
        schedule: config.tasks.healthCheck.schedule,
      },
      resolveConflicts: {
        enabled: config.tasks.resolveConflicts.enabled,
        schedule: config.tasks.resolveConflicts.schedule,
      },
      codeReview: {
        enabled: config.tasks.codeReview.enabled,
        schedule: config.tasks.codeReview.schedule,
      },
    },
  })
);

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
  "resolve-conflicts",
  config.tasks.resolveConflicts.schedule,
  config.tasks.resolveConflicts.enabled,
  () => resolveConflicts(config)
);

registerTask(
  config,
  "code-review",
  config.tasks.codeReview.schedule,
  config.tasks.codeReview.enabled,
  () => codeReview(config)
);

await sendDiscordNotification(
  config,
  "🟢 **Groundskeeper started** — health check active, monitoring wiki server."
);

console.log(
  JSON.stringify({
    timestamp: new Date().toISOString(),
    event: "ready",
  })
);
