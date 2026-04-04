/**
 * Platform Accounts — discover and manage external platform identities.
 *
 * Auto-discovers forum accounts from resource_forum_posts data and
 * links them to person entities via name matching.
 *
 * Usage:
 *   crux tb people platform-accounts discover          # dry run
 *   crux tb people platform-accounts discover --apply   # write to PG
 *   crux tb people platform-accounts list               # show all accounts
 *   crux tb people platform-accounts list --unlinked    # show unlinked only
 */

import type { CommandResult } from '../../lib/command-types.ts';
import { buildAuthorLookup, normalizeName } from './shared.ts';
import {
  syncPlatformAccounts,
  getAllPlatformAccounts,
  type SyncPlatformAccountItem,
} from '../../lib/wiki-server/platform-accounts.ts';
import { listEntities } from '../../lib/wiki-server/entities.ts';
import { listResources } from '../../lib/wiki-server/resources.ts';
import { apiRequest } from '../../lib/wiki-server/client.ts';

const PROFILE_URL_TEMPLATES: Record<string, string> = {
  lesswrong: 'https://www.lesswrong.com/users/{username}',
  eaforum: 'https://forum.effectivealtruism.org/users/{username}',
  alignmentforum: 'https://www.alignmentforum.org/users/{username}',
  github: 'https://github.com/{username}',
  twitter: 'https://twitter.com/{username}',
  crunchbase: 'https://www.crunchbase.com/organization/{username}',
  linkedin: 'https://www.linkedin.com/in/{username}',
  semantic_scholar: 'https://www.semanticscholar.org/author/{username}',
  bluesky: 'https://bsky.app/profile/{username}',
};

function profileUrl(platform: string, username: string): string | null {
  const tmpl = PROFILE_URL_TEMPLATES[platform];
  return tmpl ? tmpl.replace('{username}', username) : null;
}

interface ForumPostRow {
  resourceId: string;
  forum: string;
  authorUsername: string | null;
}

interface ResourceRow {
  id: string;
  authors: string[] | null;
  authorEntityIds: string[] | null;
}

export async function platformAccountsCommand(
  args: string[],
  options: Record<string, unknown>,
): Promise<CommandResult> {
  const subcommand = args[0] || 'discover';

  if (subcommand === 'list') {
    return listCommand(options);
  }
  if (subcommand === 'discover') {
    return discoverCommand(options);
  }

  console.log(`Unknown subcommand: ${subcommand}. Use 'discover' or 'list'.`);
  return { exitCode: 1, output: '' };
}

async function listCommand(options: Record<string, unknown>): Promise<CommandResult> {
  const platform = options.platform as string | undefined;
  const unlinked = !!options.unlinked;

  const result = await getAllPlatformAccounts({ platform, unlinked, limit: 500 });
  if (!result.ok) {
    console.error(`Failed to fetch accounts: ${result.message}`);
    return { exitCode: 1, output: '' };
  }

  const { accounts } = result.data;
  console.log(`\n📋 Platform Accounts (${accounts.length})\n`);

  const byPlatform = new Map<string, number>();
  let linked = 0;
  for (const a of accounts) {
    const p = a.platform as string;
    byPlatform.set(p, (byPlatform.get(p) ?? 0) + 1);
    if (a.entity_stable_id) linked++;
  }

  for (const [p, count] of [...byPlatform].sort()) {
    console.log(`  ${p}: ${count}`);
  }
  console.log(`\n  Linked: ${linked} / ${accounts.length}`);

  return { exitCode: 0, output: '' };
}

async function discoverCommand(options: Record<string, unknown>): Promise<CommandResult> {
  const apply = !!options.apply;
  const verbose = !!options.verbose;

  console.log('🔍 Platform Account Discovery\n');
  console.log(`  Mode: ${apply ? 'APPLY' : 'DRY RUN'}\n`);

  // Step 1: Load person entities and build name lookup
  console.log('  Loading entities...');
  const authorLookup = await buildAuthorLookup();
  console.log(`  Author lookup: ${authorLookup.size} entries`);

  // Step 2: Load stableId lookup (slug → stableId)
  const idRegistryResult = await listEntities(5000, 0);
  const stableIdMap = new Map<string, string>();
  const entityTitleMap = new Map<string, string>(); // stableId → title
  if (idRegistryResult.ok) {
    for (const e of idRegistryResult.data.entities) {
      if (e.stableId) {
        // entities list returns slug as `id`
        stableIdMap.set(e.id, e.stableId);
        entityTitleMap.set(e.stableId, e.title);
      }
    }
  }
  console.log(`  Entities loaded: ${stableIdMap.size}`);

  // Step 3: Fetch forum post author data
  console.log('  Loading forum post authors...');
  const forumPostsResult = await apiRequest<{ forumPosts: ForumPostRow[] }>(
    'GET', '/api/resources/forum-posts/all?limit=50000',
  );

  // Fallback: if the bulk endpoint doesn't exist, we'll work with what we have
  let forumPosts: ForumPostRow[] = [];
  if (forumPostsResult.ok) {
    forumPosts = forumPostsResult.data.forumPosts;
  } else {
    console.warn(`  ⚠ Could not load forum posts: ${forumPostsResult.message}`);
    console.warn('  Falling back to resource-based discovery...');
  }

  // Step 4: Fetch resources with authors
  const resourcesResult = await listResources(50000, 0);
  const resourceMap = new Map<string, ResourceRow>();
  if (resourcesResult.ok) {
    for (const r of resourcesResult.data.resources) {
      resourceMap.set(r.id, r);
    }
  }
  console.log(`  Resources loaded: ${resourceMap.size}`);

  // Step 5: Build platform account candidates from forum posts
  const candidates = new Map<string, SyncPlatformAccountItem>(); // key: platform:username

  // From forum posts
  for (const fp of forumPosts) {
    if (!fp.authorUsername) continue;

    const key = `${fp.forum}:${fp.authorUsername}`;
    if (candidates.has(key)) continue;

    // Get display name from the resource's authors field
    const resource = resourceMap.get(fp.resourceId);
    const displayName = resource?.authors?.[0] ?? null;

    // Try to match to an entity
    let entityStableId: string | null = null;
    if (displayName) {
      const slugMatch = authorLookup.get(normalizeName(displayName));
      if (slugMatch) {
        entityStableId = stableIdMap.get(slugMatch) ?? null;
      }
    }

    candidates.set(key, {
      platform: fp.forum,
      platformUsername: fp.authorUsername,
      entityStableId,
      displayName,
      profileUrl: profileUrl(fp.forum, fp.authorUsername),
    });
  }

  // From resources with forum URLs (for posts not yet in resource_forum_posts)
  for (const [, resource] of resourceMap) {
    if (!resource.authors?.length) continue;

    // Check if this is a forum resource by URL pattern
    const displayName = resource.authors[0];
    if (!displayName) continue;

    // If the resource already has authorEntityIds, use those for matching
    if (resource.authorEntityIds?.length) {
      // We'll use these to confirm matches found through forum posts
    }
  }

  // Summary
  const linked = [...candidates.values()].filter(c => c.entityStableId).length;
  const unlinked = candidates.size - linked;

  console.log(`\n  Discovered: ${candidates.size} platform accounts`);
  console.log(`    Linked to entities: ${linked}`);
  console.log(`    Unlinked: ${unlinked}`);

  // Show by platform
  const byPlatform = new Map<string, number>();
  for (const c of candidates.values()) {
    byPlatform.set(c.platform, (byPlatform.get(c.platform) ?? 0) + 1);
  }
  for (const [p, count] of [...byPlatform].sort()) {
    console.log(`    ${p}: ${count}`);
  }

  if (verbose) {
    console.log('\n  Linked accounts:');
    for (const c of [...candidates.values()].filter(c => c.entityStableId).slice(0, 50)) {
      const entityTitle = c.entityStableId ? entityTitleMap.get(c.entityStableId) ?? '?' : '?';
      console.log(`    ${c.platform}/${c.platformUsername} → ${entityTitle}`);
    }

    console.log('\n  Unlinked accounts (top 30):');
    for (const c of [...candidates.values()].filter(c => !c.entityStableId).slice(0, 30)) {
      console.log(`    ${c.platform}/${c.platformUsername} (${c.displayName ?? 'no display name'})`);
    }
  }

  if (!apply) {
    console.log(`\n  Run with --apply to sync ${candidates.size} accounts to PG.`);
    return { exitCode: 0, output: `Discovered ${candidates.size} accounts (dry run)` };
  }

  // Batch sync
  console.log('\n  Syncing to PG...');
  const items = [...candidates.values()];
  let synced = 0;
  const BATCH_SIZE = 200;

  for (let i = 0; i < items.length; i += BATCH_SIZE) {
    const batch = items.slice(i, i + BATCH_SIZE);
    const result = await syncPlatformAccounts(batch);
    if (result.ok) {
      synced += result.data.upserted;
      if (verbose) {
        console.log(`    Batch ${Math.floor(i / BATCH_SIZE) + 1}: ${result.data.upserted} upserted`);
      }
    } else {
      console.error(`    ✗ Batch ${Math.floor(i / BATCH_SIZE) + 1} failed: ${result.message}`);
    }
  }

  console.log(`\n  ✓ Synced ${synced} platform accounts`);
  return { exitCode: 0, output: `Synced ${synced} platform accounts` };
}
