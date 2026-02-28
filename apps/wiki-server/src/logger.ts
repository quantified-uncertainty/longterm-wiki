import pino from "pino";

export const logger = pino({
  name: "wiki-server",
  level: process.env.LOG_LEVEL ?? "info",
});
