import pino from "pino";

export const logger = pino({
  name: "groundskeeper",
  level: process.env.LOG_LEVEL ?? "info",
});
