/**
 * Wiki Server Entity Events Sync
 *
 * Reads data/entity-events/*.yaml and syncs to /api/entity-events/sync.
 *
 * Each YAML file represents one entity's timeline:
 *
 *   entityId: sid_xxxxxxxxxx              # FK to entities.stable_id
 *   entityDisplayName: "Anthropic"        # optional fallback display name
 *   events:
 *     - date: "2020-12"                   # YYYY, YYYY-MM, or YYYY-MM-DD
 *       title: "Founded by ex-OpenAI"
 *       eventType: founding               # see VALID_EVENT_TYPES below
 *       significance: major               # major | moderate | minor (optional)
 *       description: "..."                # optional
 *       source: "https://..."             # optional URL
 *       notes: "..."                      # optional
 *
 * Item IDs are derived deterministically from (entityId, date, title) so the
 * sync is idempotent: re-running with the same YAML upserts the same rows.
 *
 * Usage:
 *   pnpm crux sys wiki-server sync-entity-events
 *   pnpm crux sys wiki-server sync-entity-events --dry-run
 *   pnpm crux sys wiki-server sync-entity-events --batch-size=50
 *
 * Environment:
 *   LONGTERMWIKI_SERVER_URL     - Base URL of the wiki server
 *   LONGTERMWIKI_SERVER_API_KEY - Bearer token for authentication
 */

import { readFileSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { contentHash } from "../../packages/factbase/src/ids.ts";
import { batchSync } from "./sync-common.ts";
import {
  asString,
  asOptionalString,
  assertPlainObject,
  loadYamlDir,
  runSyncMain,
} from "./sync-yaml-helpers.ts";

const PROJECT_ROOT = join(import.meta.dirname!, "../..");
const EVENTS_DIR = join(PROJECT_ROOT, "data/entity-events");

const DEFAULT_BATCH_SIZE = 100;

// Mirror of VALID_EVENT_TYPES / VALID_SIGNIFICANCE in
// apps/wiki-server/src/routes/tablebase/entity-events.ts.
// Keep in sync with that route's Zod schema.
export const VALID_EVENT_TYPES = [
  "founding",
  "acquisition",
  "pivot",
  "launch",
  "publication",
  "policy",
  "milestone",
  "leadership-change",
  "incident",
  "funding",
  "dissolution",
  "other",
] as const;

export const VALID_SIGNIFICANCE = ["major", "moderate", "minor"] as const;

type EventType = (typeof VALID_EVENT_TYPES)[number];
type Significance = (typeof VALID_SIGNIFICANCE)[number];

// --- Types ---

interface RawEventsFile {
  entityId?: unknown;
  entityDisplayName?: unknown;
  events?: unknown;
}

export interface SyncEntityEvent {
  id: string;
  entityId: string;
  entityDisplayName: string | null;
  date: string;
  title: string;
  description: string | null;
  eventType: EventType;
  significance: Significance | null;
  source: string | null;
  notes: string | null;
}

// --- Loader ---

/**
 * Generate a deterministic 10-char ID from (entityId, date, title).
 * Re-running the sync with the same YAML produces the same IDs, so the
 * upsert is idempotent. Editing the title produces a new row — the old
 * row remains until cleaned up via /delete-batch.
 */
export function eventIdFor(entityId: string, date: string, title: string): string {
  return contentHash(["entity-event", entityId, date, title]);
}

const DATE_RE = /^\d{4}(-\d{2}(-\d{2})?)?$/;

/**
 * Load and validate one entity-events YAML file.
 * Throws on malformed input — sync should fail-closed rather than silently skip.
 */
export function loadEventsFile(filePath: string): SyncEntityEvent[] {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = parseYaml(raw) as RawEventsFile | null;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${filePath}: top-level YAML must be an object`);
  }

  const entityId = asString(parsed.entityId, "entityId", filePath);
  const entityDisplayName = asOptionalString(
    parsed.entityDisplayName,
    "entityDisplayName",
    filePath,
  );

  if (!Array.isArray(parsed.events)) {
    throw new Error(`${filePath}: 'events' must be an array`);
  }

  const out: SyncEntityEvent[] = [];
  for (let i = 0; i < parsed.events.length; i++) {
    const where = `${filePath} events[${i}]`;
    const rawItem = parsed.events[i];
    assertPlainObject(rawItem, where);
    const ev = rawItem;

    const date = asString(ev.date, "date", where);
    if (!DATE_RE.test(date)) {
      throw new Error(
        `${where}: 'date' must be YYYY, YYYY-MM, or YYYY-MM-DD (got "${date}")`,
      );
    }

    const title = asString(ev.title, "title", where);
    const eventType = asString(ev.eventType, "eventType", where) as EventType;
    if (!(VALID_EVENT_TYPES as readonly string[]).includes(eventType)) {
      throw new Error(
        `${where}: 'eventType' must be one of ${VALID_EVENT_TYPES.join("|")} (got "${eventType}")`,
      );
    }

    let significance: Significance | null = null;
    if (ev.significance !== undefined && ev.significance !== null && ev.significance !== "") {
      const sig = asString(ev.significance, "significance", where) as Significance;
      if (!(VALID_SIGNIFICANCE as readonly string[]).includes(sig)) {
        throw new Error(
          `${where}: 'significance' must be one of ${VALID_SIGNIFICANCE.join("|")} (got "${sig}")`,
        );
      }
      significance = sig;
    }

    out.push({
      id: eventIdFor(entityId, date, title),
      entityId,
      entityDisplayName,
      date,
      title,
      description: asOptionalString(ev.description, "description", where),
      eventType,
      significance,
      source: asOptionalString(ev.source, "source", where),
      notes: asOptionalString(ev.notes, "notes", where),
    });
  }

  return out;
}

/**
 * Load all *.yaml files from data/entity-events/ and return the flattened
 * event list. Returns an empty array if the directory does not exist.
 */
export function loadAllEvents(dir: string = EVENTS_DIR): {
  events: SyncEntityEvent[];
  files: string[];
} {
  const { items, files } = loadYamlDir<SyncEntityEvent>({
    dir,
    loadFile: loadEventsFile,
    kindLabel: "event",
    describe: (ev) => `${ev.entityId}, ${ev.date}, "${ev.title}"`,
    dedupHint: "Adjust one title to disambiguate.",
  });
  return { events: items, files };
}

// --- Sync ---

export async function syncEntityEvents(
  serverUrl: string,
  events: SyncEntityEvent[],
  batchSize: number,
  options: { _sleep?: (ms: number) => Promise<void> } = {},
): Promise<{ upserted: number; errors: number }> {
  const result = await batchSync(
    `${serverUrl}/api/entity-events/sync`,
    events,
    batchSize,
    {
      bodyKey: "items",
      responseCountKey: "upserted",
      itemLabel: "entity events",
      _sleep: options._sleep,
    },
  );
  return { upserted: result.count, errors: result.errors };
}

// --- Main ---

async function main() {
  await runSyncMain<SyncEntityEvent>({
    dir: EVENTS_DIR,
    label: "entity events",
    loadAll: (d) => {
      const { events, files } = loadAllEvents(d);
      return { items: events, files };
    },
    getEntityId: (ev) => ev.entityId,
    formatDryRun: (ev) =>
      `${ev.entityId} ${ev.date} [${ev.eventType}] ${ev.title}`,
    sync: syncEntityEvents,
    defaultBatchSize: DEFAULT_BATCH_SIZE,
  });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Entity events sync failed:", err);
    process.exit(1);
  });
}
