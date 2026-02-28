import pino from "pino";

export const logger = pino({
  name: "discord-bot",
  level: process.env.LOG_LEVEL ?? "info",
});
