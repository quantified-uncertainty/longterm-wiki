import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import type { Config } from "./config.js";

let octokitInstance: Octokit | null = null;

export function getOctokit(config: Config): Octokit {
  if (octokitInstance) return octokitInstance;

  octokitInstance = new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: config.githubAppId,
      installationId: config.githubInstallationId,
      privateKey: config.githubAppPrivateKey,
    },
  });

  return octokitInstance;
}

export function parseRepo(config: Config): { owner: string; repo: string } {
  const [owner, repo] = config.githubRepo.split("/");
  return { owner, repo };
}
