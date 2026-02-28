import { spawn } from "child_process";
import type { Config } from "./config.js";
import { incrementDailyAiCount, isDailyCapReached } from "./run-tracker.js";
import { sendDiscordNotification } from "./notify.js";

export interface ClaudeResult {
  success: boolean;
  output: string;
  durationMs: number;
}

interface ClaudeOptions {
  prompt: string;
  timeoutMs?: number;
  maxTurns?: number;
  cwd?: string;
}

export async function runClaude(
  config: Config,
  options: ClaudeOptions
): Promise<ClaudeResult> {
  const { prompt, timeoutMs = 300_000, maxTurns = 20, cwd } = options;

  // Check daily cap before running
  if (isDailyCapReached(config)) {
    await sendDiscordNotification(
      config,
      "⚠️ **Daily AI run cap reached** — skipping Claude Code invocation. Non-AI tasks continue."
    );
    return {
      success: false,
      output: "Daily run cap reached",
      durationMs: 0,
    };
  }

  const start = Date.now();

  return new Promise<ClaudeResult>((resolve) => {
    const args = [
      "-p",
      prompt,
      "--max-turns",
      String(maxTurns),
      "--output-format",
      "text",
    ];

    const proc = spawn("claude", args, {
      cwd,
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        // Ensure Claude Code uses the API key from our env
        ANTHROPIC_API_KEY: process.env["ANTHROPIC_API_KEY"],
      },
    });

    // Increment daily count only after spawn succeeds (not on spawn error)
    proc.on("spawn", () => {
      incrementDailyAiCount(config);
    });

    let stdout = "";
    let stderr = "";

    proc.stdout.on("data", (data: Buffer) => {
      stdout += data.toString();
    });

    proc.stderr.on("data", (data: Buffer) => {
      stderr += data.toString();
    });

    proc.on("close", (code) => {
      const durationMs = Date.now() - start;
      resolve({
        success: code === 0,
        output: stdout || stderr,
        durationMs,
      });
    });

    proc.on("error", (err) => {
      const durationMs = Date.now() - start;
      resolve({
        success: false,
        output: `Process error: ${err.message}`,
        durationMs,
      });
    });
  });
}
