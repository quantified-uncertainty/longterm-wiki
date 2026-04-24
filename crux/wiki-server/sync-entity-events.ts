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

import { readFileSync, readdirSync, existsSync } from "fs";
import { join } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { parseCliArgs } from "../lib/cli.ts";
import { getServerUrl, getApiKey } from "../lib/wiki-server/client.ts";
import { contentHash } from "../../packages/factbase/src/ids.ts";
import { waitForHealthy, batchSync } from "./sync-common.ts";

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

interface RawEvent {
  date?: unknown;
  title?: unknown;
  eventType?: unknown;
  significance?: unknown;
  description?: unknown;
  source?: unknown;
  notes?: unknown;
}

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

function asString(v: unknown, field: string, file: string): string {
  if (typeof v !== "string" || v.trim() === "") {
    throw new Error(`${file}: '${field}' must be a non-empty string`);
  }
  return v;
}

function asOptionalString(v: unknown, field: string, file: string): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (typeof v !== "string") {
    throw new Error(`${file}: '${field}' must be a string when present`);
  }
  return v;
}

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
    const ev = parsed.events[i] as RawEvent;
    const where = `${filePath} events[${i}]`;

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
  if (!existsSync(dir)) {
    return { events: [], files: [] };
  }
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .sort();

  const all: SyncEntityEvent[] = [];
  for (const f of files) {
    const events = loadEventsFile(join(dir, f));
    all.push(...events);
  }

  // Detect duplicate IDs across files — would surface as a silent overwrite
  // server-side, so catch it here with the offending pair named.
  const seen = new Map<string, SyncEntityEvent>();
  for (const ev of all) {
    const prev = seen.get(ev.id);
    if (prev) {
      throw new Error(
        `Duplicate event ID ${ev.id} from (${prev.entityId}, ${prev.date}, "${prev.title}") and ` +
          `(${ev.entityId}, ${ev.date}, "${ev.title}"). Adjust one title to disambiguate.`,
      );
    }
    seen.set(ev.id, ev);
  }

  return { events: all, files };
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
  const args = parseCliArgs(process.argv.slice(2));
  const dryRun = args["dry-run"] === true;
  const batchSize = Number(args["batch-size"]) || DEFAULT_BATCH_SIZE;

  const serverUrl = getServerUrl();
  const apiKey = getApiKey();

  if (!serverUrl) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_URL environment variable is required",
    );
    process.exit(1);
  }
  if (!apiKey) {
    console.error(
      "Error: LONGTERMWIKI_SERVER_API_KEY environment variable is required",
    );
    process.exit(1);
  }

  console.log(`Reading entity events from: ${EVENTS_DIR}`);
  const { events, files } = loadAllEvents();
  console.log(`  Found ${files.length} files, ${events.length} events`);

  if (events.length === 0) {
    console.log("Nothing to sync.");
    return;
  }

  // Per-entity counts for visibility
  const byEntity = new Map<string, number>();
  for (const ev of events) {
    byEntity.set(ev.entityId, (byEntity.get(ev.entityId) ?? 0) + 1);
  }
  for (const [entityId, count] of [...byEntity.entries()].sort()) {
    console.log(`  ${entityId}: ${count} events`);
  }

  if (dryRun) {
    console.log("\n[dry-run] Would sync these events (showing first 10):");
    for (const ev of events.slice(0, 10)) {
      console.log(
        `  ${ev.entityId} ${ev.date} [${ev.eventType}] ${ev.title}`,
      );
    }
    if (events.length > 10) {
      console.log(`  ... and ${events.length - 10} more`);
    }
    return;
  }

  console.log("\nChecking server health...");
  const healthy = await waitForHealthy(serverUrl);
  if (!healthy) {
    console.error(
      `Error: Server at ${serverUrl} is not healthy. Aborting sync.`,
    );
    process.exit(1);
  }

  console.log(
    `\nSyncing ${events.length} entity events (batch size: ${batchSize})...`,
  );
  const result = await syncEntityEvents(serverUrl, events, batchSize);

  console.log(`\nSync complete:`);
  console.log(`  Upserted: ${result.upserted}`);
  if (result.errors > 0) {
    console.log(`  Errors:   ${result.errors}`);
    console.error(`\nSync failed with ${result.errors} event errors.`);
    process.exit(1);
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("Entity events sync failed:", err);
    process.exit(1);
  });
}
