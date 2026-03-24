/**
 * Bluesky Command Handlers
 *
 * Manage tracked Bluesky accounts and sync their posts.
 *
 * Usage:
 *   crux tb bluesky accounts                List tracked accounts
 *   crux tb bluesky add <handle> [--tags=tag1,tag2]   Add an account to track
 *   crux tb bluesky sync <handle-or-did>    Sync posts from an account
 */

import type {
  CommandOptions as BaseOptions,
  CommandResult,
} from "../lib/command-types.ts";
import {
  apiRequest,
  getServerUrl,
} from "../lib/wiki-server/client.ts";

interface CommandOptions extends BaseOptions {
  tags?: string;
  entityId?: string;
  limit?: string;
  offset?: string;
  ci?: boolean;
}

// ---- accounts command ----

async function accountsCommand(
  _args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return {
      exitCode: 1,
      output: "Error: LONGTERMWIKI_SERVER_URL not configured",
    };
  }

  const limit = options.limit ?? "100";
  const offset = options.offset ?? "0";
  const params = new URLSearchParams({ limit, offset });

  const result = await apiRequest<{
    accounts: Array<{
      did: string;
      handle: string;
      displayName: string | null;
      followerCount: number | null;
      postCount: number | null;
      relevanceTags: string[] | null;
      lastFetchedAt: string | null;
    }>;
    total: number;
  }>("GET", `/api/bluesky?${params}`);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  const { accounts, total } = result.data;

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  if (accounts.length === 0) {
    return {
      exitCode: 0,
      output: `No tracked Bluesky accounts found.\nAdd one with: crux tb bluesky add <handle>`,
    };
  }

  const lines = accounts.map((a) => {
    const tags = a.relevanceTags?.length
      ? ` [${a.relevanceTags.join(", ")}]`
      : "";
    const name = a.displayName ? ` (${a.displayName})` : "";
    const followers = a.followerCount != null ? ` ${a.followerCount} followers` : "";
    return `  @${a.handle}${name}${followers}${tags}`;
  });

  return {
    exitCode: 0,
    output: `Tracked Bluesky accounts (${total} total):\n${lines.join("\n")}`,
  };
}

// ---- add command ----

async function addCommand(
  args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const handle = args.find((a) => !a.startsWith("--"));

  if (!handle) {
    return {
      exitCode: 1,
      output: `Usage: crux tb bluesky add <handle> [--tags=tag1,tag2] [--entity-id=<stableId>]

  Add a Bluesky account to track. The handle is resolved to a DID
  via the public Bluesky API.

Examples:
  crux tb bluesky add danielfilan.bsky.social --tags=ai-safety,researcher
  crux tb bluesky add anthropic.bsky.social --entity-id=A4XoubikkQ`,
    };
  }

  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return {
      exitCode: 1,
      output: "Error: LONGTERMWIKI_SERVER_URL not configured",
    };
  }

  // Resolve handle to DID using public API
  const profileUrl = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handle)}`;
  let profile: {
    did: string;
    handle: string;
    displayName?: string;
    description?: string;
    followersCount?: number;
    postsCount?: number;
  };

  try {
    const res = await fetch(profileUrl);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        exitCode: 1,
        output: `Error: Failed to resolve Bluesky handle '${handle}' (${res.status}): ${text.slice(0, 200)}`,
      };
    }
    profile = await res.json();
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      exitCode: 1,
      output: `Error: Could not reach Bluesky API: ${msg}`,
    };
  }

  const tags = options.tags
    ? options.tags.split(",").map((t) => t.trim()).filter(Boolean)
    : null;

  const body = {
    did: profile.did,
    handle: profile.handle,
    displayName: profile.displayName ?? null,
    description: profile.description ?? null,
    followerCount: profile.followersCount ?? null,
    postCount: profile.postsCount ?? null,
    entityStableId: options.entityId ?? null,
    relevanceTags: tags,
  };

  const result = await apiRequest<{ ok: boolean; did: string }>(
    "POST",
    "/api/bluesky/accounts",
    body
  );

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  const displayName = profile.displayName ? ` (${profile.displayName})` : "";
  const tagStr = tags?.length ? `\n  Tags: ${tags.join(", ")}` : "";

  return {
    exitCode: 0,
    output: `Added @${profile.handle}${displayName}\n  DID: ${profile.did}${tagStr}`,
  };
}

// ---- sync command ----

async function syncCommand(
  args: string[],
  options: CommandOptions
): Promise<CommandResult> {
  const handleOrDid = args.find((a) => !a.startsWith("--"));

  if (!handleOrDid) {
    return {
      exitCode: 1,
      output: `Usage: crux tb bluesky sync <handle-or-did>

  Fetch recent posts from a tracked Bluesky account and upsert them.
  The account must already be added via 'crux tb bluesky add'.

Examples:
  crux tb bluesky sync danielfilan.bsky.social
  crux tb bluesky sync did:plc:abc123`,
    };
  }

  const serverUrl = getServerUrl();
  if (!serverUrl) {
    return {
      exitCode: 1,
      output: "Error: LONGTERMWIKI_SERVER_URL not configured",
    };
  }

  // If a handle was provided, resolve to DID first
  let did = handleOrDid;
  if (!handleOrDid.startsWith("did:")) {
    const profileUrl = `https://public.api.bsky.app/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(handleOrDid)}`;
    try {
      const res = await fetch(profileUrl);
      if (!res.ok) {
        return {
          exitCode: 1,
          output: `Error: Could not resolve handle '${handleOrDid}' to DID`,
        };
      }
      const profile = (await res.json()) as { did: string };
      did = profile.did;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        exitCode: 1,
        output: `Error: Could not reach Bluesky API: ${msg}`,
      };
    }
  }

  const result = await apiRequest<{
    did: string;
    handle: string;
    postsUpserted: number;
    profileUpdated: boolean;
  }>("POST", `/api/bluesky/sync/${encodeURIComponent(did)}`);

  if (!result.ok) {
    return { exitCode: 1, output: `Error: ${result.message}` };
  }

  const { handle, postsUpserted, profileUpdated } = result.data;

  if (options.ci) {
    return { exitCode: 0, output: JSON.stringify(result.data, null, 2) };
  }

  return {
    exitCode: 0,
    output: `Synced @${handle} (${did})\n  Posts upserted: ${postsUpserted}\n  Profile updated: ${profileUpdated}`,
  };
}

// ---- Exports ----

export const commands = {
  accounts: accountsCommand,
  add: addCommand,
  sync: syncCommand,
  default: accountsCommand,
};

export function getHelp(): string {
  return `
Bluesky Domain — Track Bluesky accounts and sync their posts

Commands:
  accounts                    List all tracked accounts (default)
  add <handle>                Add a Bluesky account to track
  sync <handle-or-did>        Sync posts from a tracked account (accepts handle or DID)

Options:
  --tags=tag1,tag2   Relevance tags when adding an account
  --entity-id=<id>   Link account to a wiki entity stableId
  --limit=N          Page size for accounts list (default: 100)
  --offset=N         Pagination offset (default: 0)
  --ci               JSON output

Examples:
  crux tb bluesky accounts                           List tracked accounts
  crux tb bluesky add danielfilan.bsky.social --tags=ai-safety
  crux tb bluesky sync danielfilan.bsky.social       Fetch recent posts (by handle)
  crux tb bluesky sync did:plc:abc123                Fetch recent posts (by DID)
`;
}
